/**
 * Server-only: Supabase Auth admin — create/link users, generate Supabase recovery links for password setup.
 * No secrets exposed to the browser.
 */
import { supabase } from '../lib/supabase';

function portalPublicOrigin(): string {
  const base = process.env.PORTAL_PUBLIC_ORIGIN || 'https://start.getleadlasso.io';
  return base.replace(/\/$/, '');
}

export type AuthProvisionResult = {
  userId: string | null;
  wasNewUser: boolean;
  /** Supabase-generated one-time link; only set for newly created auth users */
  setPasswordUrl: string | null;
};

async function findAuthUserIdByEmail(email: string): Promise<string | null> {
  const normalized = email.trim().toLowerCase();
  let page = 1;
  const perPage = 200;
  for (let i = 0; i < 25; i++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) {
      console.error('[auth setup] listUsers error', error);
      return null;
    }
    const u = data.users.find((x) => x.email?.toLowerCase() === normalized);
    if (u) return u.id;
    if (data.users.length < perPage) break;
    page += 1;
  }
  return null;
}

/**
 * Ensures an auth user exists for the onboarding email, links businesses.user_id, and for brand-new users
 * returns a Supabase recovery link (server-generated) for one-time password setup.
 */
export async function ensureAuthUserAndLinkBusiness(
  businessId: string,
  email: string
): Promise<AuthProvisionResult> {
  const cleanEmail = email.trim();
  let userId: string | null = await findAuthUserIdByEmail(cleanEmail);
  let wasNewUser = false;

  if (!userId) {
    const { data, error } = await supabase.auth.admin.createUser({
      email: cleanEmail,
      email_confirm: true,
    });

    if (error) {
      const msg = String(error.message || '').toLowerCase();
      const duplicate =
        msg.includes('already') ||
        msg.includes('registered') ||
        msg.includes('exists') ||
        error.status === 422;
      if (duplicate) {
        userId = await findAuthUserIdByEmail(cleanEmail);
        if (userId) {
          console.log('[auth setup] user exists');
        } else {
          console.error('[auth setup] createUser duplicate but user not found', error);
        }
      } else {
        console.error('[auth setup] createUser failed', error);
      }
    } else if (data?.user?.id) {
      userId = data.user.id;
      wasNewUser = true;
      console.log('[auth setup] user created', { userId });
    }
  } else {
    console.log('[auth setup] user exists');
  }

  if (!userId) {
    return { userId: null, wasNewUser: false, setPasswordUrl: null };
  }

  const { error: updErr } = await supabase.from('businesses').update({ user_id: userId }).eq('id', businessId);
  if (updErr) {
    console.error('[auth setup] business link failed', updErr);
  } else {
    console.log('[auth setup] business linked', { businessId, userId });
  }

  let setPasswordUrl: string | null = null;
  if (wasNewUser) {
    const redirectTo = `${portalPublicOrigin()}/auth/set-password`;
    const { data: linkData, error: linkErr } = await supabase.auth.admin.generateLink({
      type: 'recovery',
      email: cleanEmail,
      options: { redirectTo },
    });

    if (linkErr) {
      console.error('[auth setup] generateLink failed', linkErr);
    } else {
      const actionLink = (linkData as { properties?: { action_link?: string } })?.properties?.action_link;
      setPasswordUrl = actionLink ?? null;
    }
  }

  return { userId, wasNewUser, setPasswordUrl };
}
