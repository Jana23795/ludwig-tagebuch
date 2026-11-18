import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

type PushSubscriptionInput = {
  endpoint?: string;
  keys?: { p256dh?: string; auth?: string };
};

type RequestBody = {
  action?: string;
  subscription?: PushSubscriptionInput;
  endpoint?: string;
};

function corsHeaders(origin: string | null, appOrigin: string) {
  const headers = new Headers({
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin'
  });
  if (origin === appOrigin) headers.set('Access-Control-Allow-Origin', appOrigin);
  return headers;
}

function jsonResponse(body: unknown, status: number, headers: Headers) {
  const outputHeaders = new Headers(headers);
  outputHeaders.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(body), { status, headers: outputHeaders });
}

function isHttpsEndpoint(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch (_) {
    return false;
  }
}

Deno.serve(async (request: Request) => {
  const appOrigin = Deno.env.get('APP_ORIGIN') || '';
  const origin = request.headers.get('origin');
  const cors = corsHeaders(origin, appOrigin);

  if (!appOrigin) {
    return jsonResponse({ error: 'Die Push-Funktion ist noch nicht vollständig konfiguriert.' }, 500, cors);
  }
  if (origin && origin !== appOrigin) {
    return jsonResponse({ error: 'Origin nicht erlaubt.' }, 403, cors);
  }
  if (request.method === 'OPTIONS') return new Response('ok', { status: 200, headers: cors });
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Methode nicht erlaubt.' }, 405, cors);
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
      return jsonResponse({ error: 'Die Supabase-Funktion ist noch nicht vollständig konfiguriert.' }, 500, cors);
    }

    const authorization = request.headers.get('authorization') || '';
    const tokenMatch = authorization.match(/^Bearer\s+(.+)$/i);
    if (!tokenMatch) return jsonResponse({ error: 'Anmeldung erforderlich.' }, 401, cors);

    const authClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const { data: authData, error: authError } = await authClient.auth.getUser(tokenMatch[1]);
    if (authError || !authData.user) return jsonResponse({ error: 'Sitzung ungültig. Bitte erneut anmelden.' }, 401, cors);
    const userId = authData.user.id;

    let body: RequestBody;
    try {
      body = await request.json();
    } catch (_) {
      return jsonResponse({ error: 'Ungültige Anfrage.' }, 400, cors);
    }

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    if (body.action === 'list-assignees') {
      const { data: callerProfile, error: callerError } = await admin
        .from('profiles')
        .select('id, active, is_admin')
        .eq('auth_user_id', userId)
        .maybeSingle();
      if (callerError) return jsonResponse({ error: 'Das Benutzerprofil konnte nicht geprueft werden.' }, 500, cors);
      if (!callerProfile || !callerProfile.active) return jsonResponse({ error: 'Aktives Benutzerprofil erforderlich.' }, 403, cors);

      const { data: horse, error: horseError } = await admin
        .from('horses')
        .select('id')
        .eq('slug', 'ludwig')
        .maybeSingle();
      if (horseError || !horse) return jsonResponse({ error: 'Ludwig wurde nicht gefunden.' }, 500, cors);

      const { data: callerMembership, error: membershipError } = await admin
        .from('horse_members')
        .select('profile_id')
        .eq('horse_id', horse.id)
        .eq('profile_id', callerProfile.id)
        .maybeSingle();
      if (membershipError) return jsonResponse({ error: 'Der Ludwig-Zugang konnte nicht geprueft werden.' }, 500, cors);
      if (!callerMembership && !callerProfile.is_admin) return jsonResponse({ error: 'Kein Zugriff auf Ludwig.' }, 403, cors);

      const { data: memberships, error: listError } = await admin
        .from('horse_members')
        .select('profile_id')
        .eq('horse_id', horse.id);
      if (listError) return jsonResponse({ error: 'Zuweisbare Personen konnten nicht geladen werden.' }, 500, cors);
      const { data: admins, error: adminsError } = await admin
        .from('profiles')
        .select('id')
        .eq('active', true)
        .eq('is_admin', true);
      if (adminsError) return jsonResponse({ error: 'Zuweisbare Personen konnten nicht geladen werden.' }, 500, cors);
      const profileIds = [...new Set([
        ...(memberships || []).map((item: { profile_id: string }) => item.profile_id),
        ...(admins || []).map((item: { id: string }) => item.id)
      ].filter(Boolean))];
      if (!profileIds.length) return jsonResponse({ assignees: [] }, 200, cors);

      const { data: assignees, error: profilesError } = await admin
        .from('profiles')
        .select('id, display_name, username')
        .in('id', profileIds)
        .eq('active', true)
        .order('display_name', { ascending: true });
      if (profilesError) return jsonResponse({ error: 'Zuweisbare Personen konnten nicht geladen werden.' }, 500, cors);
      return jsonResponse({ assignees: assignees || [] }, 200, cors);
    }

    if (body.action === 'get-public-key') {
      const publicKey = Deno.env.get('VAPID_PUBLIC_KEY') || '';
      if (!publicKey) return jsonResponse({ error: 'Der öffentliche Push-Schlüssel fehlt.' }, 500, cors);
      return jsonResponse({ publicKey }, 200, cors);
    }

    if (body.action === 'register') {
      const subscription = body.subscription;
      const endpoint = subscription?.endpoint;
      const p256dh = subscription?.keys?.p256dh;
      const authKey = subscription?.keys?.auth;
      if (!isHttpsEndpoint(endpoint) || typeof p256dh !== 'string' || typeof authKey !== 'string') {
        return jsonResponse({ error: 'Ungültige Geräteanmeldung.' }, 400, cors);
      }

      const { data: existing, error: lookupError } = await admin
        .from('push_subscriptions')
        .select('user_id')
        .eq('endpoint', endpoint)
        .maybeSingle();
      if (lookupError) return jsonResponse({ error: 'Geräteanmeldung konnte nicht geprüft werden.' }, 500, cors);
      if (existing && existing.user_id !== userId) {
        return jsonResponse({ error: 'Diese Geräteanmeldung ist bereits einem anderen Konto zugeordnet.' }, 409, cors);
      }

      const record = {
        user_id: userId,
        endpoint,
        p256dh,
        auth_key: authKey,
        updated_at: new Date().toISOString()
      };
      const writeResult = existing
        ? await admin.from('push_subscriptions').update(record).eq('endpoint', endpoint).eq('user_id', userId)
        : await admin.from('push_subscriptions').insert(record);
      if (writeResult.error) return jsonResponse({ error: 'Geräteanmeldung konnte nicht gespeichert werden.' }, 500, cors);
      return jsonResponse({ registered: true }, 200, cors);
    }

    if (body.action === 'unregister') {
      if (!isHttpsEndpoint(body.endpoint)) return jsonResponse({ error: 'Ungültige Geräteanmeldung.' }, 400, cors);
      const { data, error } = await admin
        .from('push_subscriptions')
        .delete()
        .eq('user_id', userId)
        .eq('endpoint', body.endpoint)
        .select('id');
      if (error) return jsonResponse({ error: 'Geräteanmeldung konnte nicht entfernt werden.' }, 500, cors);
      return jsonResponse({ removed: Boolean(data?.length) }, 200, cors);
    }

    if (body.action === 'send-test') {
      if (!isHttpsEndpoint(body.endpoint)) return jsonResponse({ error: 'Ungültige Geräteanmeldung.' }, 400, cors);
      const { data: subscription, error } = await admin
        .from('push_subscriptions')
        .select('id, endpoint, p256dh, auth_key')
        .eq('user_id', userId)
        .eq('endpoint', body.endpoint)
        .maybeSingle();
      if (error) return jsonResponse({ error: 'Geräteanmeldung konnte nicht geladen werden.' }, 500, cors);
      if (!subscription) return jsonResponse({ error: 'Dieses Gerät ist noch nicht für Push registriert.' }, 404, cors);

      const publicKey = Deno.env.get('VAPID_PUBLIC_KEY') || '';
      const privateKey = Deno.env.get('VAPID_PRIVATE_KEY') || '';
      const subject = Deno.env.get('VAPID_SUBJECT') || '';
      if (!publicKey || !privateKey || !subject) {
        return jsonResponse({ error: 'Die Push-Schlüssel sind noch nicht vollständig konfiguriert.' }, 500, cors);
      }

      webpush.setVapidDetails(subject, publicKey, privateKey);
      try {
        await webpush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth_key }
          },
          JSON.stringify({
            title: '🐴 Ludwig – Push-Test',
            body: 'Prima, der Push-Test für dieses Gerät ist angekommen.',
            tag: 'ludwig-push-test',
            url: '/index.html'
          }),
          { TTL: 60 }
        );
      } catch (sendError) {
        const statusCode = (sendError as { statusCode?: number })?.statusCode;
        if (statusCode === 404 || statusCode === 410) {
          await admin.from('push_subscriptions').delete().eq('id', subscription.id).eq('user_id', userId);
          return jsonResponse({ error: 'Die Geräteanmeldung ist abgelaufen. Bitte Push erneut aktivieren.' }, 410, cors);
        }
        return jsonResponse({ error: 'Der Push-Versand ist fehlgeschlagen.' }, 502, cors);
      }

      return jsonResponse({ sent: true }, 200, cors);
    }

    return jsonResponse({ error: 'Unbekannte Aktion.' }, 400, cors);
  } catch (_) {
    return jsonResponse({ error: 'Interner Fehler der Push-Funktion.' }, 500, cors);
  }
});
