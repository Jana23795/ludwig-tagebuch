import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

type Profile = {
  id: string;
  display_name: string;
  auth_user_id: string | null;
};

type PushRow = {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth_key: string;
};

type ReminderType = 'daily_training' | 'weekly_plan_gap';

type LocalClock = {
  date: string;
  hour: number;
  minute: number;
  weekday: number;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

function localClock(now = new Date()): LocalClock {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const date = `${values.year}-${values.month}-${values.day}`;
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return { date, hour: Number(values.hour), minute: Number(values.minute), weekday };
}

function addDays(dateKey: string, amount: number): string {
  const date = new Date(`${dateKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function upcomingMonday(dateKey: string): string {
  const weekday = new Date(`${dateKey}T00:00:00Z`).getUTCDay();
  const daysUntilMonday = (8 - weekday) % 7 || 7;
  return addDays(dateKey, daysUntilMonday);
}

function planRow(entry: any): unknown[] {
  return Array.isArray(entry?.data?.row) ? entry.data.row : [];
}

function assignedProfileId(entry: any): string {
  const row = planRow(entry);
  return String(entry?.data?.assignee_profile_id || entry?.data?.assigned_profile_id || row[5] || '').trim();
}

function assignedDisplayName(entry: any): string {
  const row = planRow(entry);
  return String(entry?.data?.assigned_display_name || row[2] || '').trim();
}

function weekdayLabel(dateKey: string): string {
  const weekday = new Date(`${dateKey}T00:00:00Z`).getUTCDay();
  return ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'][weekday];
}

async function activeLudwigProfileIds(admin: ReturnType<typeof createClient>, horseId: string): Promise<Set<string>> {
  const { data: memberships, error: membershipError } = await admin
    .from('horse_members').select('profile_id').eq('horse_id', horseId);
  if (membershipError) throw membershipError;
  const ids = [...new Set((memberships || []).map((item: any) => String(item.profile_id || '')).filter(Boolean))];
  if (!ids.length) return new Set();
  const { data: profiles, error: profileError } = await admin
    .from('profiles').select('id').in('id', ids).eq('active', true);
  if (profileError) throw profileError;
  const { data: admins, error: adminError } = await admin
    .from('profiles').select('id').eq('active', true).eq('is_admin', true);
  if (adminError) throw adminError;
  return new Set([
    ...(profiles || []).map((profile: any) => String(profile.id)),
    ...(admins || []).map((profile: any) => String(profile.id))
  ]);
}

async function profileForAssignment(admin: ReturnType<typeof createClient>, horseId: string, profileId: string): Promise<Profile | null> {
  if (!profileId) return null;
  const { data: profile, error } = await admin
    .from('profiles')
    .select('id, display_name, auth_user_id, active, is_admin')
    .eq('id', profileId)
    .maybeSingle();
  if (error || !profile || !profile.active || !profile.auth_user_id) return null;
  const { data: membership, error: membershipError } = await admin
    .from('horse_members')
    .select('profile_id')
    .eq('horse_id', horseId)
    .eq('profile_id', profileId)
    .maybeSingle();
  if (membershipError || (!membership && !profile.is_admin)) return null;
  return profile as Profile;
}

async function ownerAndAdminProfiles(admin: ReturnType<typeof createClient>, horseId: string): Promise<Profile[]> {
  const { data: owners, error: ownersError } = await admin
    .from('horse_members')
    .select('profile_id')
    .eq('horse_id', horseId)
    .eq('can_manage_owner_areas', true);
  if (ownersError) throw ownersError;
  const { data: admins, error: adminsError } = await admin
    .from('profiles')
    .select('id')
    .eq('is_admin', true)
    .eq('active', true);
  if (adminsError) throw adminsError;
  const ids = [...new Set([
    ...(owners || []).map((item: any) => String(item.profile_id || '')),
    ...(admins || []).map((item: any) => String(item.id || ''))
  ].filter(Boolean))];
  if (!ids.length) return [];
  const { data: profiles, error } = await admin
    .from('profiles')
    .select('id, display_name, auth_user_id')
    .in('id', ids)
    .eq('active', true);
  if (error) throw error;
  return (profiles || []).filter((profile: any) => Boolean(profile.auth_user_id)) as Profile[];
}

async function subscriptionsForUser(admin: ReturnType<typeof createClient>, authUserId: string): Promise<PushRow[]> {
  const { data, error } = await admin
    .from('push_subscriptions')
    .select('id, user_id, endpoint, p256dh, auth_key')
    .eq('user_id', authUserId);
  if (error) throw error;
  return (data || []) as PushRow[];
}

async function claimDelivery(
  admin: ReturnType<typeof createClient>,
  reminderType: ReminderType,
  localDate: string,
  authUserId: string,
  context: Record<string, unknown>
): Promise<string | null> {
  const { data, error } = await admin.rpc('claim_ludwig_reminder_delivery', {
    p_reminder_type: reminderType,
    p_local_date: localDate,
    p_recipient_user_id: authUserId,
    p_context: context
  });
  if (error) throw error;
  return typeof data === 'string' && data ? data : null;
}

async function markDelivery(
  admin: ReturnType<typeof createClient>,
  id: string,
  status: 'sent' | 'failed',
  errorText = ''
) {
  const payload = status === 'sent'
    ? { status, sent_at: new Date().toISOString(), last_error: null }
    : { status, last_error: errorText.slice(0, 500) || 'Push konnte nicht zugestellt werden.' };
  const { error } = await admin.from('push_reminder_deliveries').update(payload).eq('id', id);
  if (error) console.error('Could not update reminder delivery status.');
}

async function sendToUser(
  admin: ReturnType<typeof createClient>,
  authUserId: string,
  reminderType: ReminderType,
  localDate: string,
  payload: Record<string, unknown>,
  context: Record<string, unknown>,
  vapid: { publicKey: string; privateKey: string; subject: string }
): Promise<boolean> {
  const deliveryId = await claimDelivery(admin, reminderType, localDate, authUserId, context);
  if (!deliveryId) return false;
  let sent = false;
  let lastError = '';
  try {
    const subscriptions = await subscriptionsForUser(admin, authUserId);
    if (!subscriptions.length) {
      await markDelivery(admin, deliveryId, 'failed', 'No active push subscription.');
      return false;
    }
    await Promise.all(subscriptions.map(async subscription => {
      try {
        await webpush.sendNotification({
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth_key }
        }, JSON.stringify(payload), { TTL: 3600 });
        sent = true;
      } catch (error) {
        const statusCode = Number((error as { statusCode?: number })?.statusCode || 0);
        if (statusCode === 404 || statusCode === 410) {
          await admin.from('push_subscriptions').delete().eq('id', subscription.id).eq('user_id', authUserId);
        }
        lastError = statusCode ? `Push service returned ${statusCode}.` : 'Push delivery failed.';
      }
    }));
    await markDelivery(admin, deliveryId, sent ? 'sent' : 'failed', lastError);
    return sent;
  } catch (error) {
    await markDelivery(admin, deliveryId, 'failed', error instanceof Error ? error.message : 'Push delivery failed.');
    return false;
  }
}

async function sendToOwnersAndAdmins(
  admin: ReturnType<typeof createClient>,
  horseId: string,
  localDate: string,
  reminderType: ReminderType,
  payload: Record<string, unknown>,
  context: Record<string, unknown>,
  vapid: { publicKey: string; privateKey: string; subject: string },
  excludeUserIds = new Set<string>()
): Promise<number> {
  const profiles = await ownerAndAdminProfiles(admin, horseId);
  const authIds = [...new Set(profiles.map(profile => profile.auth_user_id).filter((id): id is string => Boolean(id)))];
  let count = 0;
  for (const authUserId of authIds) {
    if (excludeUserIds.has(authUserId)) continue;
    const sent = await sendToUser(admin, authUserId, reminderType, localDate, payload, context, vapid);
    if (sent) count++;
  }
  return count;
}

async function processDailyReminder(
  admin: ReturnType<typeof createClient>,
  horseId: string,
  dateKey: string,
  vapid: { publicKey: string; privateKey: string; subject: string },
  appUrl: string
): Promise<{ skipped: boolean; sent: number }> {
  const { data: protocols, error: protocolError } = await admin
    .from('app_entries')
    .select('id')
    .eq('horse_id', horseId)
    .eq('module', 'protokoll')
    .eq('entry_date', dateKey)
    .limit(1);
  if (protocolError) throw protocolError;
  if (protocols?.length) return { skipped: true, sent: 0 };

  const { data: plans, error: planError } = await admin
    .from('app_entries')
    .select('data')
    .eq('horse_id', horseId)
    .eq('module', 'wochenplan')
    .eq('entry_date', dateKey)
    .limit(5);
  if (planError) throw planError;
  const plan = (plans || []).find((entry: any) => assignedProfileId(entry)) || plans?.[0] || null;
  const assignedId = assignedProfileId(plan);
  const assignedName = assignedDisplayName(plan);
  const candidate = await profileForAssignment(admin, horseId, assignedId);
  const body = assignedName
    ? `F\u00fcr heute ist noch kein Trainingsprotokoll gespeichert. Zust\u00e4ndig: ${assignedName}.`
    : 'F\u00fcr heute ist noch kein Trainingsprotokoll gespeichert. Bitte den Wochenplan pr\u00fcffen.';
  const payload = {
    title: 'Ludwig: Trainingsprotokoll offen',
    body,
    tag: `ludwig-daily-${dateKey}`,
    url: appUrl
  };
  const context = { assigned_profile_id: assignedId || null, assigned_display_name: assignedName || null };
  const tried = new Set<string>();
  if (candidate?.auth_user_id) {
    const subscriptions = await subscriptionsForUser(admin, candidate.auth_user_id);
    tried.add(candidate.auth_user_id);
    if (subscriptions.length && await sendToUser(admin, candidate.auth_user_id, 'daily_training', dateKey, payload, context, vapid)) {
      return { skipped: false, sent: 1 };
    }
  }
  const sent = await sendToOwnersAndAdmins(
    admin, horseId, dateKey, 'daily_training', payload, context, vapid, tried
  );
  return { skipped: false, sent };
}

async function processWeeklyReminder(
  admin: ReturnType<typeof createClient>,
  horseId: string,
  saturdayKey: string,
  vapid: { publicKey: string; privateKey: string; subject: string },
  appUrl: string
): Promise<{ skipped: boolean; sent: number; missing: string[] }> {
  const monday = upcomingMonday(saturdayKey);
  const days = Array.from({ length: 7 }, (_, index) => addDays(monday, index));
  const sunday = days[6];
  const { data: plans, error } = await admin
    .from('app_entries')
    .select('entry_date, data')
    .eq('horse_id', horseId)
    .eq('module', 'wochenplan')
    .gte('entry_date', monday)
    .lte('entry_date', sunday);
  if (error) throw error;
  const validAssignees = await activeLudwigProfileIds(admin, horseId);
  const assignedByDate = new Map<string, string>();
  for (const entry of plans || []) {
    const dateKey = String((entry as any).entry_date || '').slice(0, 10);
    const profileId = assignedProfileId(entry);
    if (dateKey && profileId && validAssignees.has(profileId)) assignedByDate.set(dateKey, profileId);
  }
  const missing = days.filter(day => !assignedByDate.has(day));
  if (!missing.length) return { skipped: true, sent: 0, missing: [] };
  const missingLabels = missing.map(day => `${weekdayLabel(day)} ${day.slice(8, 10)}.${day.slice(5, 7)}.`);
  const payload = {
    title: 'Ludwig: Wochenplan unvollst\u00e4ndig',
    body: `F\u00fcr ${monday.slice(8, 10)}.${monday.slice(5, 7)}.-${sunday.slice(8, 10)}.${sunday.slice(5, 7)}. fehlt eine Zuweisung: ${missingLabels.join(', ')}.`,
    tag: `ludwig-weekly-${monday}`,
    url: appUrl
  };
  const sent = await sendToOwnersAndAdmins(
    admin, horseId, monday, 'weekly_plan_gap', payload,
    { week_start: monday, week_end: sunday, missing_dates: missing }, vapid
  );
  return { skipped: false, sent, missing };
}

Deno.serve(async (request: Request) => {
  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  const cronSecret = Deno.env.get('LUDWIG_CRON_SECRET') || '';
  const authHeader = request.headers.get('authorization') || '';
  const tokenMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!cronSecret || !tokenMatch || tokenMatch[1] !== cronSecret) {
    return json({ error: 'Unauthorized.' }, 401);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const publicKey = Deno.env.get('VAPID_PUBLIC_KEY') || '';
  const privateKey = Deno.env.get('VAPID_PRIVATE_KEY') || '';
  const subject = Deno.env.get('VAPID_SUBJECT') || '';
  if (!supabaseUrl || !serviceRoleKey || !publicKey || !privateKey || !subject) {
    return json({ error: 'Reminder function is not fully configured.' }, 500);
  }

  try {
    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const { data: horse, error: horseError } = await admin
      .from('horses').select('id').eq('slug', 'ludwig').maybeSingle();
    if (horseError || !horse) return json({ error: 'Ludwig was not found.' }, 500);

    webpush.setVapidDetails(subject, publicKey, privateKey);
    const clock = localClock();
    const appUrl = Deno.env.get('APP_URL') || '/index.html';
    const results: Record<string, unknown> = { local_time: `${clock.date} ${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}` };

    if (clock.hour === 22) {
      results.daily = await processDailyReminder(admin, horse.id, clock.date, { publicKey, privateKey, subject }, appUrl);
    }
    if (clock.weekday === 6 && clock.hour === 12) {
      results.weekly = await processWeeklyReminder(admin, horse.id, clock.date, { publicKey, privateKey, subject }, appUrl);
    }
    return json({ ok: true, ...results });
  } catch (error) {
    console.error('Ludwig reminder run failed.', error instanceof Error ? error.message : 'Unknown error.');
    return json({ error: 'Reminder processing failed.' }, 500);
  }
});
