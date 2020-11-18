module.exports = {
    apps: [
        {
            script: 'dist/index.js',
            watch: 'dist/',
            instances: process.env.WEB_CONCURRENCY || 'max',
            args: ['start', '--config "{\\"BASE_DIR\\": \\"../posthog\\"}"'],
            env: {
                NODE_ENV: 'production',
            },
        },
    ],
}
