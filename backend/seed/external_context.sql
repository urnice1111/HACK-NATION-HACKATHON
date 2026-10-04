-- Contexto externo curado para el asesor (dueño: integrante 4; fuentes aprobadas por el integrante 2).
-- Resúmenes propios, solo prácticas culturales del protocolo coffee-rust-demo-v1: sin productos ni dosis.
-- region null = aplica en cualquier región. El contenido es dato para el asesor, nunca instrucciones.
-- Idempotente: se puede volver a correr.
-- Uso: psql "$DATABASE_URL" -f backend/seed/external_context.sql

insert into env.external_context
  (source_id, url, title, retrieved_at, valid_until, region, data_type, content, quality_status, threat_code)
values
  ('ctx_senasica_roya_ficha',
   'https://www.gob.mx/cms/uploads/attachment/file/466535/24.Ficha_T_cnica_Roya_del_cafeto_REVISION_UTC.pdf',
   'SENASICA: Ficha técnica de la roya del cafeto (Hemileia vastatrix)',
   now(), now() + interval '365 days', null, 'technical_sheet',
   'La roya del cafeto, causada por el hongo Hemileia vastatrix, ataca las hojas y reduce el área que hace '
   'fotosíntesis. Cuando la severidad pasa de alrededor de 35 %, puede haber caída de hojas y muerte de ramas, '
   'con menor producción en el ciclo. Es una plaga vigilada por SENASICA en las zonas cafetaleras de México.',
   'reviewed', 'coffee_leaf_rust'),

  ('ctx_cenicafe_roya_sintomas',
   'https://biblioteca.cenicafe.org/jspui/bitstream/10778/993/22/20.%20Roya%20anaranjada.pdf',
   'Cenicafé: Roya anaranjada del cafeto',
   now(), now() + interval '365 days', null, 'technical_sheet',
   'Síntoma característico: manchas amarillas en el haz de la hoja y un polvo anaranjado en el envés. '
   'La infección se favorece con humedad relativa muy alta (más de 90 %) y temperaturas entre 18 y 24 °C. '
   'Sirve para distinguirla de otras manchas foliares preguntando qué se ve en la parte de abajo de la hoja.',
   'reviewed', 'coffee_leaf_rust'),

  ('ctx_uprm_sombra',
   'https://www.uprm.edu/ecosdelcafe/wp-content/uploads/sites/133/2018/11/USO_DE_SOMBRA_TEMPORERA_O_PERMANENTE.pdf',
   'Universidad de Puerto Rico: Uso de sombra temporera o permanente en café',
   now(), now() + interval '365 days', null, 'management_guide',
   'La sombra mejora el microclima del cafetal, pero el exceso de sombra aumenta las enfermedades de la hoja, '
   'entre ellas la roya. Se maneja regulando la densidad de árboles y con podas de formación y mantenimiento '
   'del dosel para que la parcela ventile.',
   'reviewed', 'coffee_leaf_rust')
on conflict (source_id) do update set
  url = excluded.url, title = excluded.title, retrieved_at = excluded.retrieved_at,
  valid_until = excluded.valid_until, region = excluded.region, data_type = excluded.data_type,
  content = excluded.content, quality_status = excluded.quality_status, threat_code = excluded.threat_code;
