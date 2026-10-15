-- What a P2P account held on a day (see server/lib/p2p.js): the cash from an
-- imported statement, or the account's value as the platform shows it, entered
-- by hand. A value replaces the ledger's figure from that day on, so losses the
-- statements don't list still count.

CREATE TABLE p2p_balances (
    account_id   INT UNSIGNED  NOT NULL,
    balance_date DATE          NOT NULL,
    -- Cash plus money in loans, in the account's currency; NULL when only the cash is known
    value        DECIMAL(18,6) NULL,
    -- Cash not lent out
    cash         DECIMAL(18,6) NULL,
    -- 'manual' or 'import'
    source       VARCHAR(20)   NOT NULL,
    notes        VARCHAR(500)  NULL,
    PRIMARY KEY (account_id, balance_date),
    CONSTRAINT p2p_balances_account_fk FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
