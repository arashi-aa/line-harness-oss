-- Remove the legacy "AKQ game" article-introduction step 13 from the
-- SeekerStart friend_add survey scenario (2e832c35-a090-468f-943f-1d98bd3b2db2).
--
-- Prior to this migration, step_order=13 contained a hardcoded URL to
-- https://www.seekerstart.com/learn/intermediate/akq-game which is NOT a
-- pairing token. Users tapping that URL would land on the article and
-- see the gate CTA because no LINE↔pokerHP ID mapping was created.
--
-- The post-completion hook in apps/worker/src/routes/webhook.ts now sends a
-- single message containing both the article introduction text AND the
-- dynamic /link?t=TOKEN URL issued by pokerHP /api/line/create-link-url,
-- so step 13 is no longer needed.
--
-- Safety: before running this migration, verify no friend_scenarios are
-- currently progressing through step 12/13:
--   SELECT id, friend_id, current_step_order, status
--     FROM friend_scenarios
--    WHERE scenario_id = '2e832c35-a090-468f-943f-1d98bd3b2db2' AND status = 'active';

DELETE FROM scenario_steps
 WHERE scenario_id = '2e832c35-a090-468f-943f-1d98bd3b2db2'
   AND step_order = 13;
