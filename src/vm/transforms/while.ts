// https://medium.com/@bvjebin/js-infinite-loops-killing-em-e1c2f5f2db7f

export const whileLoopTimeout = (timeoutSeconds: number) => (babel: any) => {
    const t = babel.types
    return {
        visitor: {
            WhileStatement: function transformWhile(path: any) {
                const variableName = path.scope.generateUidIdentifier('timer')
                const declaration = t.declareVariable(variableName)
                path.scope.parent.push(declaration)
                const definition = t.assignmentExpression(
                    '=',
                    variableName,
                    t.callExpression(t.memberExpression(t.identifier('Date'), t.identifier('now')), [])
                )
                path.insertBefore(t.expressionStatement(definition))
                const lhs = t.parenthesizedExpression(
                    t.binaryExpression('+', variableName, t.NumericLiteral(Math.round(timeoutSeconds * 1000)))
                )
                path.get('body').pushContainer(
                    'body',
                    t.ifStatement(
                        t.binaryExpression(
                            '>',
                            t.callExpression(t.memberExpression(t.identifier('Date'), t.identifier('now')), []),
                            lhs
                        ),
                        t.throwStatement(t.stringLiteral('While Loop Timeout')),
                        null
                    )
                )
            },
        },
    }
}
