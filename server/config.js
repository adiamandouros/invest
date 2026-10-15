// Settings from the environment (.env locally, the Node.js app's variables on cPanel)

const DB_VARS = ['DB_NAME', 'DB_USER', 'DB_PASSWORD'];

export function loadConfig(env = process.env) {
    const missing = DB_VARS.filter(name => !env[name]);
    return {
        // A port number, or a socket path: LiteSpeed sets PORT to the socket it
        // forwards requests to, and the app hangs if it listens anywhere else
        port: /^\d+$/.test(env.PORT ?? '') ? Number(env.PORT) : env.PORT || 3000,
        // null until every DB_* variable is set: the app still starts, so a
        // first deploy can be checked before the database is connected
        db: missing.length ? null : {
            host: env.DB_HOST || 'localhost',
            port: Number(env.DB_PORT) || 3306,
            database: env.DB_NAME,
            user: env.DB_USER,
            password: env.DB_PASSWORD,
        },
        missingDbVars: missing,
    };
}
