import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

type Profile = { id: string; display_name: string; auth_user_id: string | null };
type PushRow = { id: string; user_id: string; endpoint: string; p256dh: string; auth_key: string };
type Horse = { id: string; slug: string; display_name: string };
type ReminderType = 'daily_training' | 'weekly_plan_gap' | 'weekly_pat' | 'monthly_feed_plan' | 'monthly_budget';
type LocalClock = { date: string; hour: number; minute: number; weekday: number };

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

// Runs shortly before 22:00 local time. If the scheduler uses a fixed UTC time
// that crosses midnight in Berlin, associate the first local hour with yesterday.
function dailyReminderDate(clock: LocalClock): string | null {
  if ((clock.hour === 21 && clock.minute >= 50) || clock.hour === 22 || clock.hour === 23) return clock.date;
  if (clock.hour === 0) return addDays(clock.date, -1);
  return null;
}

function weeklyReminderWindow(clock: LocalClock): boolean {
  // 12:00 UTC becomes 13:00 or 14:00 in Europe/Berlin, depending on DST.
  return clock.weekday === 6 && clock.hour >= 12 && clock.hour <= 14;
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

async function activeAssigneeProfileIds(admin: ReturnType<typeof createClient>, horseId: string): Promise<Set<string>> {
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

async function ownerProfiles(admin: ReturnType<typeof createClient>, horseId: string): Promise<Profile[]> {
  const { data: owners, error: ownersError } = await admin
    .from('horse_members')
    .select('profile_id')
    .eq('horse_id', horseId)
    .eq('can_manage_owner_areas', true);
  if (ownersError) throw ownersError;
  const ids = [...new Set((owners || []).map((item: any) => String(item.profile_id || '')).filter(Boolean))];
  if (!ids.length) return [];
  const { data: profiles, error } = await admin
    .from('profiles')
    .select('id, display_name, auth_user_id, is_admin')
    .in('id', ids)
    .eq('active', true);
  if (error) throw error;
  return (profiles || []).filter((profile: any) => Boolean(profile.auth_user_id) && profile.is_admin !== true) as Profile[];
}

async function subscriptionsForUser(admin: ReturnType<typeof createClient>, authUserId: string): Promise<PushRow[]> {
  const { data, error } = await admin
    .from('push_subscriptions')
    .select('id, user_id, endpoint, p256dh, auth_key')
    .eq('user_id', authUserId);
  if (error) throw error;
  return (data || []) as PushRow[];
}

async function reminderEnabledFor(
  admin: ReturnType<typeof createClient>, horseId: string, authUserId: string,
  reminderType: ReminderType
): Promise<boolean> {
  const { data: profile, error: profileError } = await admin.from('profiles')
    .select('id, is_admin').eq('auth_user_id', authUserId).eq('active', true).maybeSingle();
  if (profileError) throw profileError;
  if (!profile) return false;

  const { data: settings, error: settingsError } = await admin.from('user_settings')
    .select('notifications_enabled').eq('profile_id', profile.id).maybeSingle();
  if (settingsError) throw settingsError;
  if (settings?.notifications_enabled === false) return false;

  const { data: preference, error: preferenceError } = await admin.from('horse_notification_preferences')
    .select('enabled').eq('horse_id', horseId).eq('profile_id', profile.id)
    .eq('reminder_type', reminderType).maybeSingle();
  if (preferenceError) throw preferenceError;
  if (preference) return preference.enabled === true;

  if (profile.is_admin === true) return true;
  const { data: membership, error: membershipError } = await admin.from('horse_members')
    .select('can_manage_owner_areas').eq('horse_id', horseId).eq('profile_id', profile.id).maybeSingle();
  if (membershipError) throw membershipError;
  return membership?.can_manage_owner_areas === true;
}

async function claimDelivery(
  admin: ReturnType<typeof createClient>, horseId: string, reminderType: ReminderType,
  localDate: string, authUserId: string, context: Record<string, unknown>
): Promise<string | null> {
  const { data, error } = await admin.rpc('claim_horse_reminder_delivery', {
    p_horse_id: horseId,
    p_reminder_type: reminderType,
    p_local_date: localDate,
    p_recipient_user_id: authUserId,
    p_context: context
  });
  if (error) throw error;
  return typeof data === 'string' && data ? data : null;
}

async function markDelivery(
  admin: ReturnType<typeof createClient>, id: string, status: 'sent' | 'failed', errorText = ''
) {
  const payload = status === 'sent'
    ? { status, sent_at: new Date().toISOString(), last_error: null }
    : { status, last_error: errorText.slice(0, 500) || 'Push konnte nicht zugestellt werden.' };
  const { error } = await admin.from('push_reminder_deliveries').update(payload).eq('id', id);
  if (error) console.error('Could not update reminder delivery status.');
}

async function sendToUser(
  admin: ReturnType<typeof createClient>, horseId: string, authUserId: string,
  reminderType: ReminderType, localDate: string, payload: Record<string, unknown>,
  context: Record<string, unknown>, vapid: { publicKey: string; privateKey: string; subject: string }
): Promise<boolean> {
  if (!(await reminderEnabledFor(admin, horseId, authUserId, reminderType))) return false;
  const deliveryId = await claimDelivery(admin, horseId, reminderType, localDate, authUserId, context);
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
        }, JSON.stringify(payload), { TTL: 12 * 60 * 60 });
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
  admin: ReturnType<typeof createClient>, horseId: string, localDate: string, reminderType: ReminderType,
  payload: Record<string, unknown>, context: Record<string, unknown>,
  vapid: { publicKey: string; privateKey: string; subject: string }, excludeUserIds = new Set<string>()
): Promise<number> {
  const profiles = await ownerAndAdminProfiles(admin, horseId);
  const authIds = [...new Set(profiles.map(profile => profile.auth_user_id).filter((id): id is string => Boolean(id)))];
  let count = 0;
  for (const authUserId of authIds) {
    if (excludeUserIds.has(authUserId)) continue;
    const sent = await sendToUser(admin, horseId, authUserId, reminderType, localDate, payload, context, vapid);
    if (sent) count++;
  }
  return count;
}

async function sendToOwners(
  admin: ReturnType<typeof createClient>, horseId: string, localDate: string, reminderType: ReminderType,
  payload: Record<string, unknown>, context: Record<string, unknown>,
  vapid: { publicKey: string; privateKey: string; subject: string }, excludeUserIds = new Set<string>()
): Promise<number> {
  const profiles = await ownerProfiles(admin, horseId);
  const authIds = [...new Set(profiles.map(profile => profile.auth_user_id).filter((id): id is string => Boolean(id)))];
  let count = 0;
  for (const authUserId of authIds) {
    if (excludeUserIds.has(authUserId)) continue;
    const sent = await sendToUser(admin, horseId, authUserId, reminderType, localDate, payload, context, vapid);
    if (sent) count++;
  }
  return count;
}

async function memberProfilesForReminder(
  admin: ReturnType<typeof createClient>, horse: Horse
): Promise<Profile[]> {
  const { data: members, error: membersError } = await admin.from('horse_members')
    .select('profile_id').eq('horse_id', horse.id);
  if (membersError) throw membersError;
  const ids = [...new Set((members || []).map((item: any) => String(item.profile_id || '')).filter(Boolean))];
  const profiles: Profile[] = [];
  if (ids.length) {
    const { data, error } = await admin.from('profiles')
      .select('id, display_name, auth_user_id').in('id', ids).eq('active', true);
    if (error) throw error;
    profiles.push(...((data || []) as Profile[]));
  }
  if (horse.slug === 'ludwig') profiles.push(...await ownerAndAdminProfiles(admin, horse.id));
  const unique = new Map<string, Profile>();
  for (const profile of profiles) if (profile.auth_user_id) unique.set(profile.auth_user_id, profile);
  return [...unique.values()];
}

async function sendToHorseMembers(
  admin: ReturnType<typeof createClient>, horse: Horse, localDate: string, reminderType: ReminderType,
  payload: Record<string, unknown>, context: Record<string, unknown>,
  vapid: { publicKey: string; privateKey: string; subject: string }
): Promise<number> {
  const profiles = await memberProfilesForReminder(admin, horse);
  let count = 0;
  for (const profile of profiles) {
    if (!profile.auth_user_id) continue;
    if (await sendToUser(admin, horse.id, profile.auth_user_id, reminderType, localDate, payload, context, vapid)) count++;
  }
  return count;
}

function weeklyPATWindow(clock: LocalClock): boolean {
  return clock.weekday === 0 && clock.hour === 12;
}

function monthlyFeedReminderWindow(clock: LocalClock): boolean {
  return clock.date.slice(8, 10) === '01' && clock.hour === 12;
}

function monthlyBudgetReminderWindow(clock: LocalClock): boolean {
  return clock.date.slice(8, 10) === '25' && clock.hour === 20;
}

async function processWeeklyPATReminder(
  admin: ReturnType<typeof createClient>, horse: Horse, dateKey: string,
  vapid: { publicKey: string; privateKey: string; subject: string }, appUrl: string
): Promise<{ skipped: boolean; sent: number; since: string }> {
  const since = addDays(dateKey, -6);
  const { data: entries, error } = await admin.from('app_entries')
    .select('entry_date, data, legacy_source').eq('horse_id', horse.id).eq('module', 'pat')
    .gte('entry_date', since).lte('entry_date', dateKey).limit(100);
  if (error) throw error;
  const checks = (entries || []).filter((entry: any) => {
    const row = entry?.data?.row;
    const storedHeader = String(entry?.legacy_source || '') === 'supabase-app'
      && Array.isArray(row) && row[0] === 'Timestamp' && row[1] === 'Datum';
    return !storedHeader;
  });
  if (checks.length) return { skipped: true, sent: 0, since };
  const label = horseLabel(horse);
  const payload = {
    title: `${label}: PAT-Check fällig`,
    body: `Für ${label} wurde in den letzten sieben Tagen kein PAT-Check gespeichert.`,
    tag: `${horse.slug}-weekly-pat-${dateKey}`,
    url: appUrl
  };
  const context = { horse_id: horse.id, horse_slug: horse.slug, since, through: dateKey };
  const sent = await sendToHorseMembers(admin, horse, dateKey, 'weekly_pat', payload, context, vapid);
  return { skipped: false, sent, since };
}

async function processMonthlyReminder(
  admin: ReturnType<typeof createClient>, horse: Horse, reminderType: 'monthly_feed_plan' | 'monthly_budget',
  dateKey: string, vapid: { publicKey: string; privateKey: string; subject: string }, appUrl: string
): Promise<{ skipped: boolean; sent: number }> {
  const periodStart = `${dateKey.slice(0, 7)}-01`;
  const { data: completion, error: completionError } = await admin.from('horse_reminder_completions')
    .select('horse_id').eq('horse_id', horse.id).eq('reminder_type', reminderType)
    .eq('period_start', periodStart).maybeSingle();
  if (completionError) throw completionError;
  if (completion) return { skipped: true, sent: 0 };
  const label = horseLabel(horse);
  const isFeed = reminderType === 'monthly_feed_plan';
  const topic = isFeed ? 'Futterplan' : 'Budget';
  const payload = {
    title: `${label}: ${topic} erledigen`,
    body: `Bitte den ${topic} für ${new Date(`${periodStart}T12:00:00Z`).toLocaleDateString('de-DE', { month: 'long', year: 'numeric', timeZone: 'Europe/Berlin' })} prüfen und anschließend als erledigt markieren.`,
    tag: `${horse.slug}-${reminderType}-${periodStart}`,
    url: appUrl
  };
  const context = { horse_id: horse.id, horse_slug: horse.slug, period_start: periodStart, reminder_type: reminderType };
  const sent = await sendToHorseMembers(admin, horse, dateKey, reminderType, payload, context, vapid);
  return { skipped: false, sent };
}

function horseLabel(horse: Horse): string {
  const shortNames: Record<string, string> = { ludwig: 'Ludwig', minstel: 'Minstrel', loki: 'Loki', ushi: 'Ushi', ted: 'Ted' };
  return shortNames[horse.slug] || horse.display_name || horse.slug;
}

async function processDailyReminder(
  admin: ReturnType<typeof createClient>, horse: Horse, dateKey: string,
  vapid: { publicKey: string; privateKey: string; subject: string }, appUrl: string
): Promise<{ skipped: boolean; sent: number }> {
  const { data: protocols, error: protocolError } = await admin
    .from('app_entries').select('id').eq('horse_id', horse.id).eq('module', 'protokoll').eq('entry_date', dateKey).limit(1);
  if (protocolError) throw protocolError;
  if (protocols?.length) return { skipped: true, sent: 0 };

  const { data: plans, error: planError } = await admin
    .from('app_entries').select('data').eq('horse_id', horse.id).eq('module', 'wochenplan').eq('entry_date', dateKey).limit(5);
  if (planError) throw planError;
  const plan = (plans || []).find((entry: any) => assignedProfileId(entry)) || plans?.[0] || null;
  const assignedId = assignedProfileId(plan);
  const assignedName = assignedDisplayName(plan);
  const candidate = await profileForAssignment(admin, horse.id, assignedId);
  const label = horseLabel(horse);
  const body = assignedName
    ? `Für heute ist noch kein Trainingsprotokoll gespeichert. Zuständig: ${assignedName}.`
    : `Für heute ist noch kein Trainingsprotokoll gespeichert. Bitte den Wochenplan für ${label} prüfen.`;
  const payload = { title: `${label}: Trainingsprotokoll offen`, body, tag: `${horse.slug}-daily-${dateKey}`, url: appUrl };
  const context = {
    horse_id: horse.id, horse_slug: horse.slug,
    assigned_profile_id: assignedId || null, assigned_display_name: assignedName || null
  };
  const tried = new Set<string>();
  if (candidate?.auth_user_id) {
    const subscriptions = await subscriptionsForUser(admin, candidate.auth_user_id);
    tried.add(candidate.auth_user_id);
    if (subscriptions.length && await sendToUser(admin, horse.id, candidate.auth_user_id, 'daily_training', dateKey, payload, context, vapid)) {
      return { skipped: false, sent: 1 };
    }
  }
  const sent = horse.slug === 'ludwig'
    ? await sendToOwnersAndAdmins(admin, horse.id, dateKey, 'daily_training', payload, context, vapid, tried)
    : await sendToOwners(admin, horse.id, dateKey, 'daily_training', payload, context, vapid, tried);
  return { skipped: false, sent };
}

async function processWeeklyReminder(
  admin: ReturnType<typeof createClient>, horse: Horse, saturdayKey: string,
  vapid: { publicKey: string; privateKey: string; subject: string }, appUrl: string
): Promise<{ skipped: boolean; sent: number; missing: string[] }> {
  const monday = upcomingMonday(saturdayKey);
  const days = Array.from({ length: 7 }, (_, index) => addDays(monday, index));
  const sunday = days[6];
  const { data: plans, error } = await admin
    .from('app_entries').select('entry_date, data').eq('horse_id', horse.id).eq('module', 'wochenplan')
    .gte('entry_date', monday).lte('entry_date', sunday);
  if (error) throw error;
  const validAssignees = await activeAssigneeProfileIds(admin, horse.id);
  const assignedByDate = new Map<string, string>();
  for (const entry of plans || []) {
    const dateKey = String((entry as any).entry_date || '').slice(0, 10);
    const profileId = assignedProfileId(entry);
    if (dateKey && profileId && validAssignees.has(profileId)) assignedByDate.set(dateKey, profileId);
  }
  const missing = days.filter(day => !assignedByDate.has(day));
  if (!missing.length) return { skipped: true, sent: 0, missing: [] };
  const missingLabels = missing.map(day => `${weekdayLabel(day)} ${day.slice(8, 10)}.${day.slice(5, 7)}.`);
  const label = horseLabel(horse);
  const payload = {
    title: `${label}: Wochenplan unvollständig`,
    body: `Für ${monday.slice(8, 10)}.${monday.slice(5, 7)}.-${sunday.slice(8, 10)}.${sunday.slice(5, 7)}. fehlt bei ${label} eine Zuweisung: ${missingLabels.join(', ')}.`,
    tag: `${horse.slug}-weekly-${monday}`,
    url: appUrl
  };
  const context = { horse_id: horse.id, horse_slug: horse.slug, week_start: monday, week_end: sunday, missing_dates: missing };
  const sent = horse.slug === 'ludwig'
    ? await sendToOwnersAndAdmins(admin, horse.id, monday, 'weekly_plan_gap', payload, context, vapid)
    : await sendToOwners(admin, horse.id, monday, 'weekly_plan_gap', payload, context, vapid);
  return { skipped: false, sent, missing };
}

Deno.serve(async (request: Request) => {
  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  const cronSecret = Deno.env.get('LUDWIG_CRON_SECRET') || '';
  const authHeader = request.headers.get('authorization') || '';
  const tokenMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!cronSecret || !tokenMatch || tokenMatch[1] !== cronSecret) return json({ error: 'Unauthorized.' }, 401);

  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const publicKey = Deno.env.get('VAPID_PUBLIC_KEY') || '';
  const privateKey = Deno.env.get('VAPID_PRIVATE_KEY') || '';
  const subject = Deno.env.get('VAPID_SUBJECT') || '';
  if (!supabaseUrl || !serviceRoleKey || !publicKey || !privateKey || !subject) {
    return json({ error: 'Reminder function is not fully configured.' }, 500);
  }

  try {
    const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: horses, error: horsesError } = await admin.from('horses').select('id, slug, display_name').order('slug', { ascending: true });
    if (horsesError) throw horsesError;
    if (!horses?.length) return json({ error: 'No horses are configured.' }, 500);

    webpush.setVapidDetails(subject, publicKey, privateKey);
    const clock = localClock();
    const dailyDate = dailyReminderDate(clock);
    const appUrl = Deno.env.get('APP_URL') || '/index.html';
    const results: Record<string, unknown> = {
      local_time: `${clock.date} ${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`,
      daily_target_date: dailyDate,
      weekly_window: weeklyReminderWindow(clock),
      weekly_pat_window: weeklyPATWindow(clock),
      monthly_feed_window: monthlyFeedReminderWindow(clock),
      monthly_budget_window: monthlyBudgetReminderWindow(clock)
    };

    if (dailyDate) {
      const daily: Record<string, unknown> = {};
      for (const horse of horses as Horse[]) {
        daily[horse.slug] = await processDailyReminder(admin, horse, dailyDate, { publicKey, privateKey, subject }, appUrl);
      }
      results.daily = daily;
    }
    if (weeklyReminderWindow(clock)) {
      const weekly: Record<string, unknown> = {};
      for (const horse of horses as Horse[]) {
        weekly[horse.slug] = await processWeeklyReminder(admin, horse, clock.date, { publicKey, privateKey, subject }, appUrl);
      }
      results.weekly = weekly;
    }
    if (weeklyPATWindow(clock)) {
      const pat: Record<string, unknown> = {};
      for (const horse of horses as Horse[]) {
        pat[horse.slug] = await processWeeklyPATReminder(admin, horse, clock.date, { publicKey, privateKey, subject }, appUrl);
      }
      results.weekly_pat = pat;
    }
    if (monthlyFeedReminderWindow(clock)) {
      const feed: Record<string, unknown> = {};
      for (const horse of horses as Horse[]) {
        feed[horse.slug] = await processMonthlyReminder(admin, horse, 'monthly_feed_plan', clock.date, { publicKey, privateKey, subject }, appUrl);
      }
      results.monthly_feed_plan = feed;
    }
    if (monthlyBudgetReminderWindow(clock)) {
      const budget: Record<string, unknown> = {};
      for (const horse of horses as Horse[]) {
        budget[horse.slug] = await processMonthlyReminder(admin, horse, 'monthly_budget', clock.date, { publicKey, privateKey, subject }, appUrl);
      }
      results.monthly_budget = budget;
    }
    return json({ ok: true, ...results });
  } catch (error) {
    console.error('Multi-horse reminder run failed.', error instanceof Error ? error.message : 'Unknown error.');
    return json({ error: 'Reminder processing failed.' }, 500);
  }
});
