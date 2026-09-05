-- ============================================================
-- Sistema de horarios v2 — tabla completa por ramal (no cola manual)
-- AMBIENTE DE PRUEBAS. Si ya habías corrido horarios-schema-test.sql,
-- esto lo reemplaza por completo (se pierden los datos de prueba que
-- hayas metido ahí, pero es el ambiente de pruebas, no pasa nada).
-- ============================================================

drop table if exists corridas;
drop table if exists ramales_config;

create table ramales_config (
  ramal text primary key check (ramal in ('capilla','secundaria')),
  nombre text not null,
  hora_inicio int not null default 300,   -- minutos desde medianoche (300 = 5:00am)
  hora_fin int not null default 1320,     -- 1320 = 10:00pm
  intervalo int not null default 7,       -- minutos entre cada salida
  tiempo_vuelta int not null default 50   -- minutos totales, ida + vuelta
);

insert into ramales_config (ramal, nombre, hora_inicio, hora_fin, intervalo, tiempo_vuelta)
values ('capilla', 'Por Capilla', 300, 1320, 7, 50),
       ('secundaria', 'Por Secundaria', 300, 1320, 8, 50);

create table corridas (
  id uuid primary key default gen_random_uuid(),
  ramal text not null check (ramal in ('capilla','secundaria')),
  slot_index int not null,               -- posición en la tabla del día (0,1,2...)
  unit_id uuid references units(id) on delete set null,
  driver_id uuid references drivers(id) on delete set null,
  hora_salida int not null,
  hora_llega int not null,
  fecha date not null default current_date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (ramal, fecha, slot_index)
);

create index corridas_fecha_ramal_idx on corridas (fecha, ramal, slot_index);
create index corridas_driver_fecha_idx on corridas (driver_id, fecha);

alter table ramales_config enable row level security;
alter table corridas enable row level security;

create policy "ramales_config_all" on ramales_config for all using (true) with check (true);
create policy "corridas_all" on corridas for all using (true) with check (true);
