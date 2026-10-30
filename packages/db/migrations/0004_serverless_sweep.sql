-- Serverless deployments finalise calls inline; the maintenance sweep finds any that were
-- missed. This partial index keeps that lookup to the handful of unfinalised rows.
create index if not exists calls_unfinalised_idx
  on calls ((coalesce(ended_at, started_at)))
  where billed_seconds is null and outcome <> 'in_progress';
