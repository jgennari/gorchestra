-- The dashboard is a disposable projection over the durable event stream.
-- Rebuild it once so historical completed shell calls gain deterministic
-- commit, pull-request, and test outcomes under the new classifier.
DELETE FROM dashboard_runs;
