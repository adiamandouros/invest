-- Small app-wide choices by name, like the benchmark to compare the
-- portfolio with (see server/lib/benchmark.js)

CREATE TABLE app_settings (
    name  VARCHAR(50)  NOT NULL PRIMARY KEY,
    value VARCHAR(200) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
