import { initApp } from './init'
import { startPluginsServer } from './main/pluginsServer'
import { defaultConfig } from './shared/config'
import { makePiscina } from './worker/piscina'

initApp(defaultConfig)
void startPluginsServer(defaultConfig, makePiscina) // void the returned promise
