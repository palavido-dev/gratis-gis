-- The organization's time zone, an IANA name such as
-- America/Los_Angeles. Expressions read it for today(), so a date
-- filter on the server, a preview in the browser and the offline
-- field app agree on what day it is. Null means UTC.
ALTER TABLE organization ADD COLUMN time_zone text;
