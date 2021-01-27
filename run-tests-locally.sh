#!/bin/bash

set +ex

if [[ -z $PRIMARY_DB ]]; then
    echo 'You must provide var PRIMARY_DB! Either "postgres" or "clickhouse"'
    exit 1
fi

export REDIS_URL='redis://localhost'
export CLICKHOUSE_HOST=localhost
export CLICKHOUSE_DATABASE=posthog_test
export KAFKA_ENABLED=true
export KAFKA_HOSTS=kafka:9092

source ../posthog/env/bin/activate
SECRET_KEY=abc DATABASE_URL='postgres://postgres:postgres@localhost:5432/posthog' TEST=true python ../posthog/manage.py setup_test_environment
DATABASE_URL='postgres://postgres:postgres@localhost:5432/test_posthog' yarn test:$PRIMARY_DB
