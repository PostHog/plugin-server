import { createServer } from '../src/server'

async function task() {
    const [server, closeServer] = await createServer()

    await server.db.query(createPlugin)
    await server.db.query(createPluginAttachment)
    await server.db.query(createPluginConfig)

    await closeServer()
}

const ifNotExists = 'if not exists'

const createPlugin = `
    create table ${ifNotExists} posthog_plugin
    (
        id            serial  not null
            constraint posthog_plugin_pkey
                primary key,
        name          varchar(200),
        description   text,
        url           varchar(800),
        config_schema jsonb   not null,
        tag           varchar(200),
        archive       bytea,
        from_json     boolean not null,
        from_web      boolean not null,
        error         jsonb
    );
`

const createPluginAttachment = `
    create table ${ifNotExists} posthog_pluginattachment
    (
        id               serial       not null
            constraint posthog_pluginattachment_pkey
                primary key,
        key              varchar(200) not null,
        content_type     varchar(200) not null,
        file_name        varchar(200) not null,
        file_size        integer      not null,
        contents         bytea        not null,
        plugin_config_id integer      not null
            constraint posthog_pluginattach_plugin_config_id_cc94a1b9_fk_posthog_p
                references posthog_pluginconfig
                deferrable initially deferred,
        team_id          integer
            constraint posthog_pluginattachment_team_id_415eacc7_fk_posthog_team_id
                references posthog_team
                deferrable initially deferred
    );
    
    create index ${ifNotExists} posthog_pluginattachment_plugin_config_id_cc94a1b9
        on posthog_pluginattachment (plugin_config_id);
    
    create index ${ifNotExists} posthog_pluginattachment_team_id_415eacc7
        on posthog_pluginattachment (team_id);
`

const createPluginConfig = `
    create table ${ifNotExists} posthog_pluginconfig
    (
        id        serial  not null
            constraint posthog_pluginconfig_pkey
                primary key,
        team_id   integer
            constraint posthog_pluginconfig_team_id_71185766_fk_posthog_team_id
                references posthog_team
                deferrable initially deferred,
        plugin_id integer not null
            constraint posthog_pluginconfig_plugin_id_d014ca1c_fk_posthog_plugin_id
                references posthog_plugin
                deferrable initially deferred,
        enabled   boolean not null,
        "order"   integer,
        config    jsonb   not null,
        error     jsonb
    );
    
    create index ${ifNotExists} posthog_pluginconfig_team_id_71185766
        on posthog_pluginconfig (team_id);
    
    create index ${ifNotExists} posthog_pluginconfig_plugin_id_d014ca1c
        on posthog_pluginconfig (plugin_id);
`

task()
