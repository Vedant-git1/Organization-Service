CREATE TABLE `organizations` (
    `id` CHAR(36) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `slug` VARCHAR(100) NOT NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    `created_at` TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    UNIQUE INDEX `organizations_slug_key`(`slug`),
    INDEX `idx_organizations_status`(`status`),
    INDEX `idx_organizations_created_at`(`created_at`),
    INDEX `idx_organizations_name`(`name`),
    PRIMARY KEY (`id`),
    CONSTRAINT `organizations_status_check` CHECK (`status` IN ('ACTIVE', 'SUSPENDED'))
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
