-- Demo fixtures (INSTRUCTIONS.md section 13). Synthetic data: is_demo = true everywhere.
-- Phones are fictitious. Expects psql variable :artifact with the risk model JSON
-- (see backend/scripts/reset_db.sh).

begin;

-- Contacts: farmers 01 and 02 share a phone. Contact 06 has no notification consent.
insert into public.contacts (id, is_demo, phone_e164, is_shared, report_consent, notification_consent, followup_call_consent, consent_at) values
  ('contact_demo_01', true, '+525500000001', true,  true, true,  true,  now() - interval '30 days'),
  ('contact_demo_03', true, '+525500000003', false, true, true,  true,  now() - interval '30 days'),
  ('contact_demo_04', true, '+525500000004', false, true, true,  true,  now() - interval '30 days'),
  ('contact_demo_05', true, '+525500000005', false, true, true,  true,  now() - interval '30 days'),
  ('contact_demo_06', true, '+525500000006', false, true, false, true,  now() - interval '30 days'),
  ('contact_demo_07', true, '+525500000007', false, true, true,  false, now() - interval '30 days'),
  ('contact_demo_08', true, '+525500000008', false, false, false, false, null);

insert into public.farmers (id, is_demo, name, contact_id) values
  ('farmer_demo_01', true, 'Agricultor Demo 1', 'contact_demo_01'),
  ('farmer_demo_02', true, 'Agricultor Demo 2', 'contact_demo_01'),
  ('farmer_demo_03', true, 'Agricultor Demo 3', 'contact_demo_03'),
  ('farmer_demo_04', true, 'Agricultor Demo 4', 'contact_demo_04'),
  ('farmer_demo_05', true, 'Agricultor Demo 5', 'contact_demo_05'),
  ('farmer_demo_06', true, 'Agricultor Demo 6', 'contact_demo_06'),
  ('farmer_demo_07', true, 'Agricultor Demo 7', 'contact_demo_07'),
  ('farmer_demo_08', true, 'Agricultor Demo 8', 'contact_demo_08');

-- Plots 01-04 around Coatepec, 05-06 around Huatusco.
-- 07 and 08 have no context (no variety/altitude, no env summary); 08 is outside dataset coverage.
insert into public.plots (id, is_demo, farmer_id, name, latitude, longitude, crop, variety, altitude_m) values
  ('plot_demo_01', true, 'farmer_demo_01', 'Parcela 1', 19.452, -96.961, 'coffee', 'Typica',    1250),
  ('plot_demo_02', true, 'farmer_demo_02', 'Parcela 2', 19.470, -96.930, 'coffee', 'Caturra',   1300),
  ('plot_demo_03', true, 'farmer_demo_03', 'Parcela 3', 19.430, -96.990, 'coffee', 'Bourbon',   1200),
  ('plot_demo_04', true, 'farmer_demo_04', 'Parcela 4', 19.520, -96.920, 'coffee', 'Marsellesa', 1400),
  ('plot_demo_05', true, 'farmer_demo_05', 'Parcela 5', 19.150, -96.960, 'coffee', 'Costa Rica 95', 1350),
  ('plot_demo_06', true, 'farmer_demo_06', 'Parcela 6', 19.170, -96.940, 'coffee', 'Typica',    1320),
  ('plot_demo_07', true, 'farmer_demo_07', 'Parcela 7', 19.400, -97.050, 'coffee', null, null),
  ('plot_demo_08', true, 'farmer_demo_08', 'Parcela 8', 16.750, -93.100, 'coffee', null, null);

-- Cases: 01 high-priority active, 02 ambiguous active, r1-r3 resolved.
insert into public.cases (id, is_demo, plot_id, threat_code, status, opened_at, last_observation_at, closed_at, close_reason, closed_by) values
  ('case_demo_01', true, 'plot_demo_01', 'coffee_leaf_rust', 'suspected', now() - interval '2 days', now() - interval '2 days', null, null, null),
  ('case_demo_02', true, 'plot_demo_03', 'coffee_leaf_rust', 'reported',  now() - interval '1 day',  now() - interval '1 day',  null, null, null),
  ('case_demo_r1', true, 'plot_demo_05', 'coffee_leaf_rust', 'resolved',  now() - interval '40 days', now() - interval '30 days', now() - interval '28 days', 'Verificado por agrónomo', 'agronomist_demo'),
  ('case_demo_r2', true, 'plot_demo_06', 'coffee_leaf_rust', 'resolved',  now() - interval '25 days', now() - interval '13 days', now() - interval '13 days', 'Resuelto según seguimiento', 'followup'),
  ('case_demo_r3', true, 'plot_demo_04', 'coffee_leaf_rust', 'resolved',  now() - interval '60 days', now() - interval '45 days', now() - interval '45 days', 'Resuelto según seguimiento', 'followup');

insert into public.reports (id, is_demo, case_id, plot_id, session_id, channel, observed_at, received_at, symptoms, user_statement, completeness, provider_reference, assessment_id, processing_status) values
  -- High priority, enough information.
  ('report_demo_01', true, 'case_demo_01', 'plot_demo_01', 'session_demo_01', 'voice', null, now() - interval '2 days',
   '{"manchas amarillas en hojas","polvo naranja en el envés","caída de hojas"}',
   'Tengo manchas amarillas y un polvito naranja abajo de las hojas, ya se están cayendo', 'sufficient', 'provider-demo-01', 'assessment_demo_01', 'processed'),
  -- Ambiguous.
  ('report_demo_02', true, 'case_demo_02', 'plot_demo_03', 'session_demo_02', 'sms', null, now() - interval '1 day',
   '{"manchas en hojas"}',
   'Veo unas manchas raras en algunas matas', 'partial', 'provider-demo-02', 'assessment_demo_02', 'processed'),
  -- Follow-up answers that produced resolutions r2 and r3.
  ('report_demo_r2', true, 'case_demo_r2', 'plot_demo_06', 'session_demo_r2', 'voice', null, now() - interval '13 days',
   '{}', 'Ya no salen manchas desde que quité las hojas y le abrí la sombra', 'sufficient', 'provider-demo-r2', null, 'processed'),
  ('report_demo_r3', true, 'case_demo_r3', 'plot_demo_04', 'session_demo_r3', 'voice', null, now() - interval '45 days',
   '{}', 'Le eché caldo bordelés, 3 kilos en 200 litros, y se compuso', 'sufficient', 'provider-demo-r3', null, 'processed');

insert into public.assessments (id, is_demo, report_id, session_id, plot_id, disposition, suspected_issue, evidence_quality, urgency, information_needs, data_used, recommendations, model_version, protocol_version) values
  ('assessment_demo_01', true, 'report_demo_01', 'session_demo_01', 'plot_demo_01', 'advise',
   '{"code": "coffee_leaf_rust", "label": "Posible roya del café", "certainty": "suspected"}', 'medium', 'soon', '[]',
   '[{"query_id": "q_demo_01", "summary": "Humedad promedio 14 días por encima de lo normal", "data_freshness": "fresh", "dataset_ids": ["dataset_demo"]}]',
   '[{"code": "remove_affected_leaves", "text": "Retirar hojas con manchas y enterrarlas fuera de la parcela", "protocol_id": "coffee-rust-demo-v1", "source_ids": []}]',
   'mock', 'coffee-rust-demo-v1'),
  ('assessment_demo_02', true, 'report_demo_02', 'session_demo_02', 'plot_demo_03', 'ask_more', null, 'insufficient', 'unknown',
   '[{"need_code": "leaf_underside", "variable": "Aspecto del envés de las hojas afectadas", "reason": "Distingue roya de otros problemas", "farmer_hint": "Preguntar qué ve en la parte de abajo de las hojas", "answer_type": "choice", "options": ["polvo naranja o amarillo", "pelusa blanca", "insectos o galerías", "nada", "no sé"], "priority": 1, "can_be_unknown": true}]',
   '[]', '[]', 'mock', 'coffee-rust-demo-v1');

-- Hand-made risk model, active.
insert into public.risk_models (id, is_demo, threat_code, model_version, artifact, status, activated_at) values
  ('risk_model_demo_01', true, 'coffee_leaf_rust', '0.1.0-heuristic', :'artifact'::jsonb, 'active', now() - interval '3 days');

-- Current priority per plot (scores computed with the heuristic artifact).
insert into public.risk_evaluations (id, is_demo, plot_id, threat_code, score, inspection_priority, feature_vector, contributions, reasons, evidence_report_ids, source_case_ids, model_version, heuristic, data_freshness, created_at) values
  ('risk_demo_01', true, 'plot_demo_01', 'coffee_leaf_rust', 0.8705, 'high',
   '{"humidity_mean_14d": 88, "rain_anomaly_30d": 1.8, "temp_optimal_days_14d": 11, "neighbor_source_exposure": 0.46, "direct_active_reports": 1}',
   '[{"feature": "direct_active_reports", "value": 0.24}, {"feature": "rain_anomaly_30d", "value": 0.12}, {"feature": "humidity_mean_14d", "value": 0.1}]',
   '{"Reporte directo activo","Lluvia por encima de lo normal","Humedad por encima de lo normal"}',
   '{report_demo_01}', '{case_demo_01}', '0.1.0-heuristic', true, 'fresh', now() - interval '2 days'),
  ('risk_demo_02', true, 'plot_demo_02', 'coffee_leaf_rust', 0.574, 'medium',
   '{"humidity_mean_14d": 86, "rain_anomaly_30d": 1.6, "temp_optimal_days_14d": 10, "neighbor_source_exposure": 0.68, "direct_active_reports": 0}',
   '[{"feature": "neighbor_source_exposure", "value": 0.114}, {"feature": "rain_anomaly_30d", "value": 0.09}, {"feature": "humidity_mean_14d", "value": 0.08}]',
   '{"Vecina de parcelas con caso activo","Lluvia por encima de lo normal"}',
   '{}', '{case_demo_01,case_demo_02}', '0.1.0-heuristic', true, 'fresh', now() - interval '1 day'),
  ('risk_demo_03', true, 'plot_demo_03', 'coffee_leaf_rust', 0.6855, 'medium',
   '{"humidity_mean_14d": 82, "rain_anomaly_30d": 1.3, "temp_optimal_days_14d": 7, "neighbor_source_exposure": 0.46, "direct_active_reports": 1}',
   '[{"feature": "direct_active_reports", "value": 0.24}, {"feature": "neighbor_source_exposure", "value": 0.048}, {"feature": "rain_anomaly_30d", "value": 0.045}]',
   '{"Reporte directo activo (ambiguo)","Vecina de parcela con caso activo"}',
   '{report_demo_02}', '{case_demo_01,case_demo_02}', '0.1.0-heuristic', true, 'fresh', now() - interval '1 day'),
  ('risk_demo_04_old', true, 'plot_demo_04', 'coffee_leaf_rust', 0.45, 'medium',
   '{}', '[]', '{"Evaluación anterior"}', '{}', '{case_demo_01}', '0.1.0-heuristic', true, 'stale', now() - interval '3 days'),
  ('risk_demo_04', true, 'plot_demo_04', 'coffee_leaf_rust', 0.2665, 'low',
   '{"humidity_mean_14d": 80, "rain_anomaly_30d": 1.2, "temp_optimal_days_14d": 7, "neighbor_source_exposure": 0.18, "direct_active_reports": 0}',
   '[{"feature": "direct_active_reports", "value": -0.06}, {"feature": "neighbor_source_exposure", "value": -0.036}, {"feature": "rain_anomaly_30d", "value": 0.03}]',
   '{"Exposición baja a casos activos"}', '{}', '{case_demo_01}', '0.1.0-heuristic', true, 'fresh', now() - interval '1 day'),
  ('risk_demo_05', true, 'plot_demo_05', 'coffee_leaf_rust', 0.0825, 'low',
   '{"humidity_mean_14d": 74, "rain_anomaly_30d": 0.9, "temp_optimal_days_14d": 5, "neighbor_source_exposure": 0, "direct_active_reports": 0}',
   '[{"feature": "neighbor_source_exposure", "value": -0.09}, {"feature": "direct_active_reports", "value": -0.06}, {"feature": "humidity_mean_14d", "value": -0.04}]',
   '{"Sin casos activos cerca"}', '{}', '{}', '0.1.0-heuristic', true, 'fresh', now() - interval '1 day'),
  ('risk_demo_06', true, 'plot_demo_06', 'coffee_leaf_rust', 0.08, 'low',
   '{"humidity_mean_14d": 75, "rain_anomaly_30d": 0.9, "temp_optimal_days_14d": 4, "neighbor_source_exposure": 0, "direct_active_reports": 0}',
   '[{"feature": "neighbor_source_exposure", "value": -0.09}, {"feature": "direct_active_reports", "value": -0.06}, {"feature": "humidity_mean_14d", "value": -0.03}]',
   '{"Sin casos activos cerca"}', '{}', '{}', '0.1.0-heuristic', true, 'fresh', now() - interval '1 day'),
  ('risk_demo_07', true, 'plot_demo_07', 'coffee_leaf_rust', null, 'unknown',
   '{"humidity_mean_14d": null, "rain_anomaly_30d": null, "temp_optimal_days_14d": null, "neighbor_source_exposure": 0.24, "direct_active_reports": 0}',
   '[]', '{"Sin datos ambientales para la parcela"}', '{}', '{case_demo_02}', '0.1.0-heuristic', true, 'unknown', now() - interval '1 day'),
  ('risk_demo_08', true, 'plot_demo_08', 'coffee_leaf_rust', null, 'unknown',
   '{"humidity_mean_14d": null, "rain_anomaly_30d": null, "temp_optimal_days_14d": null, "neighbor_source_exposure": 0, "direct_active_reports": 0}',
   '[]', '{"Fuera de la cobertura de los datasets"}', '{}', '{}', '0.1.0-heuristic', true, 'unknown', now() - interval '1 day');

-- Edges within 10 km (hypothetical rules). exposure_strength = exp(-d/5) only when an end has an active case.
insert into public.edges (id, is_demo, source_plot_id, target_plot_id, threat_code, distance_km, environment_similarity, exposure_type, exposure_strength, missing_features, rule_version) values
  ('edge_demo_01_02', true, 'plot_demo_01', 'plot_demo_02', 'coffee_leaf_rust', 3.82, 0.92, 'proximity', 0.47, '{}', 'edges-v1-hypothetical'),
  ('edge_demo_01_03', true, 'plot_demo_01', 'plot_demo_03', 'coffee_leaf_rust', 3.90, 0.88, 'proximity', 0.46, '{}', 'edges-v1-hypothetical'),
  ('edge_demo_01_04', true, 'plot_demo_01', 'plot_demo_04', 'coffee_leaf_rust', 8.70, 0.81, 'proximity', 0.18, '{}', 'edges-v1-hypothetical'),
  ('edge_demo_02_03', true, 'plot_demo_02', 'plot_demo_03', 'coffee_leaf_rust', 7.70, 0.85, 'proximity', 0.21, '{}', 'edges-v1-hypothetical'),
  ('edge_demo_02_04', true, 'plot_demo_02', 'plot_demo_04', 'coffee_leaf_rust', 5.66, 0.86, 'proximity', null, '{}', 'edges-v1-hypothetical'),
  ('edge_demo_03_07', true, 'plot_demo_03', 'plot_demo_07', 'coffee_leaf_rust', 7.12, null, 'proximity', 0.24,
   '{humidity_mean_14d,rain_anomaly_30d,temp_optimal_days_14d}', 'edges-v1-hypothetical'),
  ('edge_demo_05_06', true, 'plot_demo_05', 'plot_demo_06', 'coffee_leaf_rust', 3.06, 0.95, 'proximity', null, '{}', 'edges-v1-hypothetical');

-- Alerts: one approved (send failed), one rejected, one pending review.
insert into public.alerts (id, is_demo, plot_id, threat_code, risk_evaluation_id, status, message, dedup_key, review_reason, approved_by, approved_at) values
  ('alert_demo_01', true, 'plot_demo_02', 'coffee_leaf_rust', 'risk_demo_02', 'queued',
   'Se reportaron síntomas en la zona. Revisa tu parcela y responde si observas cambios. Este aviso no confirma afectación.',
   'plot_demo_02:coffee_leaf_rust:case_demo_01', 'Aviso preventivo revisado', 'operator_demo', now() - interval '20 hours'),
  ('alert_demo_02', true, 'plot_demo_04', 'coffee_leaf_rust', 'risk_demo_04_old', 'rejected', null,
   'plot_demo_04:coffee_leaf_rust:case_demo_01', 'Exposición baja, no amerita aviso', null, null),
  ('alert_demo_03', true, 'plot_demo_03', 'coffee_leaf_rust', 'risk_demo_03', 'pending_review',
   'Se reportaron síntomas en la zona. Revisa tu parcela y responde si observas cambios. Este aviso no confirma afectación.',
   'plot_demo_03:coffee_leaf_rust:case_demo_01', null, null, null);

-- Follow-ups: one overdue, one without answer, two answered (resolutions r2, r3).
insert into public.followups (id, is_demo, case_id, due_at, status, channel, attempt_count, call_reference, response_report_id) values
  ('followup_demo_01', true, 'case_demo_01', now() - interval '10 minutes', 'scheduled', 'voice', 0, null, null),
  ('followup_demo_02', true, 'case_demo_02', now() - interval '3 hours', 'no_response', 'voice', 3, 'call-demo-02', null),
  ('followup_demo_r2', true, 'case_demo_r2', now() - interval '13 days', 'responded', 'voice', 1, 'call-demo-r2', 'report_demo_r2'),
  ('followup_demo_r3', true, 'case_demo_r3', now() - interval '45 days', 'responded', 'voice', 1, 'call-demo-r3', 'report_demo_r3');

insert into public.notifications (id, is_demo, alert_id, followup_id, contact_id, channel, status, provider_reference, attempt_count, last_error) values
  ('notification_demo_01', true, 'alert_demo_01', null, 'contact_demo_01', 'voice', 'failed', 'provider-demo-n01', 3, 'no_answer'),
  ('notification_demo_02', true, null, 'followup_demo_02', 'contact_demo_03', 'sms', 'delivered', 'provider-demo-n02', 1, null);

-- Resolved cases: one verified, one farmer_reported, one that mentions a product and dose
-- (the advisor must omit it: matches_protocol = false).
insert into public.case_resolutions (id, is_demo, case_id, plot_id, threat_code, symptoms, resolved_at, solution_statement, solution_codes, matches_protocol, outcome, verification, followup_id, verified_by) values
  ('resolution_demo_01', true, 'case_demo_r1', 'plot_demo_05', 'coffee_leaf_rust', '{"manchas amarillas en hojas","polvo naranja en el envés"}',
   now() - interval '28 days', 'Retiró hojas afectadas, reguló la sombra y fertilizó', '{remove_affected_leaves,regulate_shade,nutrition}', true,
   'resolved', 'verified', null, 'agronomist_demo'),
  ('resolution_demo_02', true, 'case_demo_r2', 'plot_demo_06', 'coffee_leaf_rust', '{"manchas amarillas en hojas"}',
   now() - interval '13 days', 'Quitó hojas con manchas y abrió la sombra', '{remove_affected_leaves,regulate_shade}', true,
   'resolved', 'farmer_reported', 'followup_demo_r2', null),
  ('resolution_demo_03', true, 'case_demo_r3', 'plot_demo_04', 'coffee_leaf_rust', '{"manchas amarillas en hojas","caída de hojas"}',
   now() - interval '45 days', 'Le eché caldo bordelés, 3 kilos en 200 litros', '{copper_fungicide}', false,
   'resolved', 'farmer_reported', 'followup_demo_r3', null);

commit;
