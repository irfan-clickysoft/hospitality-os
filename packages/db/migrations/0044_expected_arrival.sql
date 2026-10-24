-- 0044 The time a guest expects to arrive on the day (local time of the property), so the desk can plan the day and see the arrivals in order.
ALTER TABLE reservation ADD COLUMN expected_arrival time;
