CREATE TABLE default.cohortpeople
(
    `person_id` UUID,
    `cohort_id` Int64,
    `team_id` Int64,
    `sign` Int8
)
ENGINE = CollapsingMergeTree(sign)
ORDER BY (team_id, cohort_id, person_id)
SETTINGS index_granularity = 8192
;
CREATE TABLE default.events
(
    `uuid` UUID,
    `event` String,
    `properties` String,
    `timestamp` DateTime64(6, 'UTC'),
    `team_id` Int64,
    `distinct_id` String,
    `elements_chain` String,
    `created_at` DateTime64(6, 'UTC'),
    `properties_issampledevent` String MATERIALIZED replaceRegexpAll(JSONExtractRaw(properties, 'isSampledEvent'), concat('^[', regexpQuoteMeta('"'), ']*|[', regexpQuoteMeta('"'), ']*$'), '') COMMENT 'column_materializer::isSampledEvent',
    `properties_currentscreen` String MATERIALIZED replaceRegexpAll(JSONExtractRaw(properties, 'currentScreen'), concat('^[', regexpQuoteMeta('"'), ']*|[', regexpQuoteMeta('"'), ']*$'), '') COMMENT 'column_materializer::currentScreen',
    `properties_objectname` String MATERIALIZED replaceRegexpAll(JSONExtractRaw(properties, 'objectName'), concat('^[', regexpQuoteMeta('"'), ']*|[', regexpQuoteMeta('"'), ']*$'), '') COMMENT 'column_materializer::objectName',
    `properties_test_prop` String MATERIALIZED replaceRegexpAll(JSONExtractRaw(properties, 'test_prop'), concat('^[', regexpQuoteMeta('"'), ']*|[', regexpQuoteMeta('"'), ']*$'), ''),
    `_timestamp` DateTime,
    `_offset` UInt64
)
ENGINE = ReplacingMergeTree(_timestamp)
PARTITION BY toYYYYMM(timestamp)
ORDER BY (team_id, toDate(timestamp), distinct_id, uuid)
SETTINGS index_granularity = 8192
;
CREATE MATERIALIZED VIEW default.events_mv TO default.events
(
    `uuid` UUID,
    `event` String,
    `properties` String,
    `timestamp` DateTime64(6, 'UTC'),
    `team_id` Int64,
    `distinct_id` String,
    `elements_chain` String,
    `created_at` DateTime64(6, 'UTC'),
    `_timestamp` Nullable(DateTime),
    `_offset` UInt64
) AS
SELECT
    uuid,
    event,
    properties,
    timestamp,
    team_id,
    distinct_id,
    elements_chain,
    created_at,
    _timestamp,
    _offset
FROM default.kafka_events
;
CREATE TABLE default.infi_clickhouse_orm_migrations
(
    `package_name` String,
    `module_name` String,
    `applied` Date DEFAULT '1970-01-01'
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(applied)
ORDER BY (package_name, module_name)
SETTINGS index_granularity = 8192
;
CREATE TABLE default.kafka_events
(
    `uuid` UUID,
    `event` String,
    `properties` String,
    `timestamp` DateTime64(6, 'UTC'),
    `team_id` Int64,
    `distinct_id` String,
    `elements_chain` String,
    `created_at` DateTime64(6, 'UTC')
)
ENGINE = Kafka
SETTINGS kafka_broker_list = 'kafka', kafka_topic_list = 'clickhouse_events_proto', kafka_group_name = 'group1', kafka_format = 'Protobuf', kafka_schema = 'events:Event', kafka_skip_broken_messages = 100
;
CREATE TABLE default.kafka_person
(
    `id` UUID,
    `created_at` DateTime64(3),
    `team_id` Int64,
    `properties` String,
    `is_identified` Int8,
    `is_deleted` Int8 DEFAULT 0
)
ENGINE = Kafka('kafka', 'clickhouse_person', 'group1', 'JSONEachRow')
;
CREATE TABLE default.kafka_person_distinct_id
(
    `distinct_id` String,
    `person_id` UUID,
    `team_id` Int64,
    `_sign` Nullable(Int8),
    `is_deleted` Nullable(Int8)
)
ENGINE = Kafka('kafka', 'clickhouse_person_unique_id', 'group1', 'JSONEachRow')
;
CREATE TABLE default.kafka_plugin_log_entries
(
    `id` UUID,
    `team_id` Int64,
    `plugin_id` Int64,
    `plugin_config_id` Int64,
    `timestamp` DateTime64(6, 'UTC'),
    `source` String,
    `type` String,
    `message` String,
    `instance_id` UUID
)
ENGINE = Kafka('kafka', 'plugin_log_entries', 'group1', 'JSONEachRow')
;
CREATE TABLE default.kafka_session_recording_events
(
    `uuid` UUID,
    `timestamp` DateTime64(6, 'UTC'),
    `team_id` Int64,
    `distinct_id` String,
    `session_id` String,
    `snapshot_data` String,
    `created_at` DateTime64(6, 'UTC')
)
ENGINE = Kafka('kafka', 'clickhouse_session_recording_events', 'group1', 'JSONEachRow')
;
CREATE TABLE default.person
(
    `id` UUID,
    `created_at` DateTime64(3),
    `team_id` Int64,
    `properties` String,
    `is_identified` Int8,
    `is_deleted` Int8 DEFAULT 0,
    `_timestamp` DateTime,
    `_offset` UInt64
)
ENGINE = ReplacingMergeTree(_timestamp)
ORDER BY (team_id, id)
SETTINGS index_granularity = 8192
;
CREATE TABLE default.person_distinct_id
(
    `distinct_id` String,
    `person_id` UUID,
    `team_id` Int64,
    `_sign` Int8 DEFAULT 1,
    `is_deleted` Int8 ALIAS if(_sign = -1, 1, 0),
    `_timestamp` DateTime,
    `_offset` UInt64
)
ENGINE = CollapsingMergeTree(_sign)
ORDER BY (team_id, distinct_id, person_id)
SETTINGS index_granularity = 8192
;
CREATE TABLE default.person_distinct_id_backup
(
    `distinct_id` String,
    `person_id` UUID,
    `team_id` Int64,
    `_sign` Int8 DEFAULT 1,
    `is_deleted` Int8 ALIAS if(_sign = -1, 1, 0),
    `_timestamp` DateTime,
    `_offset` UInt64
)
ENGINE = CollapsingMergeTree(_sign)
ORDER BY (team_id, distinct_id, person_id)
SETTINGS index_granularity = 8192
;
CREATE MATERIALIZED VIEW default.person_distinct_id_mv TO default.person_distinct_id
(
    `distinct_id` String,
    `person_id` UUID,
    `team_id` Int64,
    `_sign` Int16,
    `_timestamp` Nullable(DateTime),
    `_offset` UInt64
) AS
SELECT
    distinct_id,
    person_id,
    team_id,
    coalesce(_sign, if(is_deleted = 0, 1, -1)) AS _sign,
    _timestamp,
    _offset
FROM default.kafka_person_distinct_id
;
CREATE MATERIALIZED VIEW default.person_mv TO default.person
(
    `id` UUID,
    `created_at` DateTime64(3),
    `team_id` Int64,
    `properties` String,
    `is_identified` Int8,
    `is_deleted` Int8,
    `_timestamp` Nullable(DateTime),
    `_offset` UInt64
) AS
SELECT
    id,
    created_at,
    team_id,
    properties,
    is_identified,
    is_deleted,
    _timestamp,
    _offset
FROM default.kafka_person
;
CREATE TABLE default.person_static_cohort
(
    `id` UUID,
    `person_id` UUID,
    `cohort_id` Int64,
    `team_id` Int64,
    `_timestamp` DateTime,
    `_offset` UInt64
)
ENGINE = ReplacingMergeTree(_timestamp)
ORDER BY (team_id, cohort_id, person_id, id)
SETTINGS index_granularity = 8192
;
CREATE TABLE default.plugin_log_entries
(
    `id` UUID,
    `team_id` Int64,
    `plugin_id` Int64,
    `plugin_config_id` Int64,
    `timestamp` DateTime64(6, 'UTC'),
    `source` String,
    `type` String,
    `message` String,
    `instance_id` UUID,
    `_timestamp` DateTime,
    `_offset` UInt64
)
ENGINE = ReplacingMergeTree(_timestamp)
PARTITION BY plugin_id
ORDER BY (team_id, id)
TTL toDate(timestamp) + toIntervalWeek(1)
SETTINGS index_granularity = 512
;
CREATE MATERIALIZED VIEW default.plugin_log_entries_mv TO default.plugin_log_entries
(
    `id` UUID,
    `team_id` Int64,
    `plugin_id` Int64,
    `plugin_config_id` Int64,
    `timestamp` DateTime64(6, 'UTC'),
    `source` String,
    `type` String,
    `message` String,
    `instance_id` UUID,
    `_timestamp` Nullable(DateTime),
    `_offset` UInt64
) AS
SELECT
    id,
    team_id,
    plugin_id,
    plugin_config_id,
    timestamp,
    source,
    type,
    message,
    instance_id,
    _timestamp,
    _offset
FROM default.kafka_plugin_log_entries
;
CREATE TABLE default.session_recording_events
(
    `uuid` UUID,
    `timestamp` DateTime64(6, 'UTC'),
    `team_id` Int64,
    `distinct_id` String,
    `session_id` String,
    `snapshot_data` String,
    `created_at` DateTime64(6, 'UTC'),
    `_timestamp` DateTime,
    `_offset` UInt64
)
ENGINE = ReplacingMergeTree(_timestamp)
PARTITION BY toYYYYMMDD(timestamp)
ORDER BY (team_id, toHour(timestamp), session_id, timestamp, uuid)
TTL toDate(created_at) + toIntervalWeek(3)
SETTINGS index_granularity = 512
;
CREATE MATERIALIZED VIEW default.session_recording_events_mv TO default.session_recording_events
(
    `uuid` UUID,
    `timestamp` DateTime64(6, 'UTC'),
    `team_id` Int64,
    `distinct_id` String,
    `session_id` String,
    `snapshot_data` String,
    `created_at` DateTime64(6, 'UTC'),
    `_timestamp` Nullable(DateTime),
    `_offset` UInt64
) AS
SELECT
    uuid,
    timestamp,
    team_id,
    distinct_id,
    session_id,
    snapshot_data,
    created_at,
    _timestamp,
    _offset
FROM default.kafka_session_recording_events
;
