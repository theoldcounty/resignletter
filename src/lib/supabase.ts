import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export function getSupabaseClient() {
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('Supabase is not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.');
  }

  return createClient(supabaseUrl, supabaseAnonKey);
}

export interface ResignationLetter {
  id: string;
  manager_name: string;
  company: string;
  last_day: string;
  reason: string | null;
  tone: string;
  letter_text: string | null;
  paid: boolean;
  payment_intent_id: string | null;
  created_at: string;
}

export interface LetterFormData {
  managerName: string;
  company: string;
  lastDay: string;
  reason: string;
  tone: 'grateful' | 'professional' | 'direct';
}
