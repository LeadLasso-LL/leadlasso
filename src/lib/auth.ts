/**
 * Verify Supabase JWT from Authorization: Bearer and resolve the owner's business.
 */
import type { Request } from 'express';
import type { User } from '@supabase/supabase-js';
import { supabase } from './supabase';
import type { BusinessRow } from './supabase';

export async function getBearerUser(req: Request): Promise<User | null> {
  const header = req.headers.authorization;
  const hasBearer = Boolean(header?.startsWith('Bearer '));
  const token = hasBearer ? header!.slice(7).trim() : '';

  console.log('[auth] getBearerUser', {
    hasAuthorizationHeader: Boolean(header),
    hasBearer,
    tokenPreview: token ? `${token.slice(0, 12)}... (len=${token.length})` : null,
  });

  if (!hasBearer || !token) return null;

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) {
    console.error('[auth] getBearerUser verify failed', {
      message: error?.message,
      status: error?.status,
      tokenPreview: `${token.slice(0, 12)}... (len=${token.length})`,
    });
    return null;
  }

  console.log('[auth] getBearerUser ok', { userId: data.user.id, email: data.user.email });
  return data.user;
}

export async function getBusinessForUser(userId: string): Promise<BusinessRow | null> {
  const { data, error } = await supabase
    .from('businesses')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}
