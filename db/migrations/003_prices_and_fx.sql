-- Daily closing prices, ECB exchange rates, and when each was last updated
-- (see server/market/)

CREATE TABLE prices (
    instrument_id INT UNSIGNED  NOT NULL,
    price_date    DATE          NOT NULL,
    close         DECIMAL(18,6) NOT NULL,
    -- The price's currency, which can differ from the trades' (e.g. a USD listing)
    currency      CHAR(3)       NOT NULL,
    -- 'yahoo' or 'manual'
    source        VARCHAR(20)   NOT NULL,
    PRIMARY KEY (instrument_id, price_date),
    CONSTRAINT prices_instrument_fk FOREIGN KEY (instrument_id) REFERENCES instruments (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE fx_rates (
    currency  CHAR(3)       NOT NULL,
    rate_date DATE          NOT NULL,
    -- Units of `currency` for 1 EUR, as the ECB publishes it (e.g. 1.1186 USD)
    per_eur   DECIMAL(18,8) NOT NULL,
    PRIMARY KEY (currency, rate_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE market_updates (
    -- 'prices' or 'fx'
    name       VARCHAR(20)  NOT NULL PRIMARY KEY,
    checked_at DATETIME     NOT NULL,
    ok         TINYINT(1)   NOT NULL,
    message    VARCHAR(1000) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
