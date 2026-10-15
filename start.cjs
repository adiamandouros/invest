// The startup file for cPanel's "Setup Node.js App". LiteSpeed loads it with
// require(), and Node 20 before 20.19 can't require() an ES module at all
// (ERR_REQUIRE_ESM), so this CommonJS file loads the app with import() instead.
import('./server.js').catch(err => {
    console.error(err);
    process.exit(1);
});
