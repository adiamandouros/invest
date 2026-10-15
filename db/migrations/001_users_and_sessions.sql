-- The app's user, and sign-in sessions (see server/auth/)

CREATE TABLE users (
    id             INT UNSIGNED    NOT NULL AUTO_INCREMENT PRIMARY KEY,
    username       VARCHAR(64)     NOT NULL,
    -- scrypt$N$r$p$salt$hash (server/auth/password.js)
    password_hash  VARCHAR(255)    NOT NULL,
    -- The authenticator secret, encrypted with ENCRYPTION_KEY; NULL until it's set up
    totp_secret    VARCHAR(255)    NULL,
    -- The last time step a code was accepted for, so no code works twice
    totp_last_step BIGINT UNSIGNED NULL,
    failed_logins  INT UNSIGNED    NOT NULL DEFAULT 0,
    locked_until   DATETIME        NULL,
    created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY users_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE sessions (
    -- SHA-256 of the cookie's token: the token itself is never stored
    token_hash   CHAR(64)                 NOT NULL PRIMARY KEY,
    user_id      INT UNSIGNED             NOT NULL,
    -- 'password' while the authenticator code is still to come
    stage        ENUM('password', 'full') NOT NULL,
    csrf_token   VARCHAR(64)              NOT NULL,
    -- A new authenticator secret being set up (encrypted), until it's confirmed
    pending_totp VARCHAR(255)             NULL,
    expires_at   DATETIME                 NOT NULL,
    created_at   DATETIME                 NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY sessions_user (user_id),
    KEY sessions_expires (expires_at),
    CONSTRAINT sessions_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
