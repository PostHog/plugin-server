// inspired by: https://github.com/treywood/babel-plugin-bluebird-async-functions/
import { PluginsServer } from '../../types'

const REPLACED = Symbol()

export const promiseTimeout = (server: PluginsServer) => (babel: any) => {
    const t = babel.types
    return {
        visitor: {
            // changes: bla.then --> __asyncGuard(bla).then
            MemberExpression: {
                exit(path: any) {
                    const { node } = path
                    if (
                        node.property &&
                        t.isIdentifier(node.property) &&
                        node.property.name === 'then' &&
                        !node[REPLACED]
                    ) {
                        const newCall = t.memberExpression(
                            t.callExpression(t.identifier('__asyncGuard'), [node.object]),
                            t.identifier('then')
                        )
                        newCall[REPLACED] = true
                        path.replaceWith(newCall)
                    }
                },
            },

            // changes: await bla --> await __asyncGuard(bla)
            AwaitExpression: {
                exit(path: any) {
                    const { node } = path
                    if (node && !node[REPLACED]) {
                        const newAwait = t.awaitExpression(
                            t.callExpression(t.identifier('__asyncGuard'), [node.argument])
                        )
                        newAwait[REPLACED] = true
                        path.replaceWith(newAwait)
                    }
                },
            },
        },
    }
}
