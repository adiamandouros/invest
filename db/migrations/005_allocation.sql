-- Allocation targets (see server/lib/allocation.js): groups like "S&P 500"
-- or "P2P lending" with the share of the portfolio each should have, and the
-- group each instrument and account belongs to.

CREATE TABLE allocation_groups (
    id         INT UNSIGNED  NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name       VARCHAR(50)   NOT NULL,
    -- Percent of the whole, e.g. 60.0000; the groups add up to 100
    target_pct DECIMAL(7,4)  NOT NULL,
    position   INT           NOT NULL DEFAULT 0,
    UNIQUE KEY allocation_groups_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE instruments
    ADD COLUMN allocation_group_id INT UNSIGNED NULL,
    ADD CONSTRAINT instruments_allocation_group_fk FOREIGN KEY (allocation_group_id) REFERENCES allocation_groups (id) ON DELETE SET NULL;

ALTER TABLE accounts
    ADD COLUMN allocation_group_id INT UNSIGNED NULL,
    ADD CONSTRAINT accounts_allocation_group_fk FOREIGN KEY (allocation_group_id) REFERENCES allocation_groups (id) ON DELETE SET NULL;
