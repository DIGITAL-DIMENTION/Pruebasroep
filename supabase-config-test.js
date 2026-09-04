/* ============================================================
   CONFIGURACIÓN DE SUPABASE — Ruta San Simón (R-18) · AMBIENTE DE PRUEBAS
   ============================================================
   Este archivo apunta a tu proyecto de Supabase de PRUEBAS, separado por
   completo del de producción. Es usado por las copias *-test.html /
   *-test-logic.js. El archivo original supabase-config.js (producción)
   no se toca. */
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const supabaseUrl = 'https://exjjjcyepsrzzampbmut.supabase.co';
const supabaseAnonKey = 'sb_publishable_kJqa_WI3YTfvmcYpJneC7w_W85qrx_w';

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  }
});
