-- Consumer prices (the HICP index, monthly, from the ECB) for figures after
-- inflation (see server/lib/inflation.js)

CREATE TABLE price_index (
    -- 'GR' for Greece
    area        CHAR(2)       NOT NULL,
    -- 'YYYY-MM'
    month       CHAR(7)       NOT NULL,
    index_value DECIMAL(12,4) NOT NULL,
    PRIMARY KEY (area, month)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
