-- Accounts at brokers and P2P platforms, the instruments held, and one
-- ledger of everything that happened in each account (see server/lib/holdings.js)

CREATE TABLE accounts (
    id            INT UNSIGNED  NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name          VARCHAR(100)  NOT NULL,
    kind          ENUM('broker', 'p2p') NOT NULL,
    -- 'freedom24', 'mintos', 'peerberry', ...
    platform      VARCHAR(50)   NOT NULL,
    -- The account's number at the platform, to match imported statements
    external_ref  VARCHAR(100)  NULL,
    base_currency CHAR(3)       NOT NULL DEFAULT 'EUR',
    opened_on     DATE          NULL,
    notes         VARCHAR(500)  NULL,
    created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY accounts_platform_ref (platform, external_ref)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE instruments (
    id           INT UNSIGNED  NOT NULL AUTO_INCREMENT PRIMARY KEY,
    isin         CHAR(12)      NULL,
    -- The ticker as the broker names it, e.g. VUAA.EU
    symbol       VARCHAR(32)   NOT NULL,
    name         VARCHAR(200)  NOT NULL,
    kind         ENUM('etf', 'stock', 'other') NOT NULL DEFAULT 'etf',
    -- The currency it trades in
    currency     CHAR(3)       NOT NULL,
    -- NULL until known
    distributing TINYINT(1)    NULL,
    asset_class  VARCHAR(50)   NULL,
    -- For daily prices (phase 3)
    price_symbol VARCHAR(32)   NULL,
    price_source VARCHAR(20)   NULL,
    created_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY instruments_isin (isin)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE transactions (
    id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    account_id    INT UNSIGNED    NOT NULL,
    instrument_id INT UNSIGNED    NULL,
    type          ENUM('buy', 'sell', 'shares_in', 'shares_out', 'dividend', 'tax', 'fee', 'interest',
                       'deposit', 'withdrawal', 'transfer_in', 'transfer_out', 'exchange') NOT NULL,
    trade_date    DATE            NOT NULL,
    -- Shares bought, sold, received or given; NULL for cash-only rows
    units         DECIMAL(18,6)   NULL,
    price         DECIMAL(18,6)   NULL,
    -- The cash effect, signed: a buy is negative, a sale or dividend positive.
    -- Not counting the fee, which is always taken from the cash.
    amount        DECIMAL(18,6)   NOT NULL,
    currency      CHAR(3)         NOT NULL,
    fee           DECIMAL(18,6)   NOT NULL DEFAULT 0,
    fee_currency  CHAR(3)         NULL,
    -- EUR for one unit of `currency` on the day, when known
    fx_to_eur     DECIMAL(18,8)   NULL,
    -- The row's ID in an imported statement, so importing again adds nothing twice
    import_ref    VARCHAR(100)    NULL,
    notes         VARCHAR(500)    NULL,
    created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY transactions_import_ref (account_id, import_ref),
    KEY transactions_account_date (account_id, trade_date),
    KEY transactions_instrument_date (instrument_id, trade_date),
    CONSTRAINT transactions_account_fk FOREIGN KEY (account_id) REFERENCES accounts (id),
    CONSTRAINT transactions_instrument_fk FOREIGN KEY (instrument_id) REFERENCES instruments (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
