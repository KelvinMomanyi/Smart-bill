CREATE TABLE "AccountingConnection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT,
    "tenantId" TEXT,
    "realmId" TEXT,
    "scopes" TEXT,
    "expiresAt" DATETIME,
    "connectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "AccountingConnection_shop_platform_key" ON "AccountingConnection"("shop", "platform");
