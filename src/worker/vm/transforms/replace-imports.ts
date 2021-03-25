import { PluginsServer } from '../../../types'
import { PluginGen } from './common'

export const replaceImports: PluginGen = (server: PluginsServer, imports: Record<string, any> = {}) => ({
    types: t,
}) => ({
    visitor: {
        ImportDeclaration: {
            exit(path: any) {
                const { node } = path
                const importSource = node.source.value
                const importedVars = new Map<string, string>()

                if (typeof imports[importSource] === 'undefined') {
                    throw new Error(`Can not import from "${importSource}". It's not in the whitelisted packages.`)
                }

                for (const specifier of node.specifiers) {
                    if (t.isImportSpecifier(specifier)) {
                        if (t.isStringLiteral(specifier.imported)) {
                            importedVars.set(specifier.local.name, specifier.imported.value)
                        } else {
                            importedVars.set(specifier.local.name, specifier.imported.name)
                        }
                    } else if (t.isImportDefaultSpecifier(specifier)) {
                        importedVars.set(specifier.local.name, 'default')
                    } else if (t.isImportNamespaceSpecifier(specifier)) {
                        importedVars.set(specifier.local.name, 'default')
                    }
                }

                path.replaceWith(
                    t.variableDeclaration(
                        'const',
                        Array.from(importedVars.entries()).map(([varName, sourceName]) => {
                            return t.variableDeclarator(
                                t.identifier(varName),
                                t.memberExpression(
                                    t.memberExpression(
                                        t.identifier('__pluginHostImports'),
                                        t.stringLiteral(importSource),
                                        true
                                    ),
                                    t.stringLiteral(sourceName),
                                    true
                                )
                            )
                        })
                    )
                )
            },
        },
    },
})
