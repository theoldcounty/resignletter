import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

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
