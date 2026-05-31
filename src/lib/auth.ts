/**
 * Verify Supabase JWT from Authorization: Bearer and resolve the owner's business.
 */
import type { Request } from 'express';
import type { User } from '@supabase/supabase-js';
import { supabase } from './supabase';
import type { BusinessRow } from './supabase';

export async function getBearerUser(req: Request): Promise<User | null> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  if (!token) return null;

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return null;
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
