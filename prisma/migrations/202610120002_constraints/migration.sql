ALTER TABLE "Transaction" ADD CONSTRAINT "positive_amount" CHECK (amount > 0);
ALTER TABLE "Transaction" ADD CONSTRAINT "valid_type" CHECK (type IN ('income', 'expense', 'transfer'));
ALTER TABLE "Transaction" ADD CONSTRAINT "valid_transaction_status" CHECK (status IN ('active', 'void'));
ALTER TABLE "Transaction" ADD CONSTRAINT "transfer_accounts" CHECK (type <> 'transfer' OR ("accountId" IS NOT NULL AND "toAccountId" IS NOT NULL AND "accountId" <> "toAccountId"));
ALTER TABLE "Budget" ADD CONSTRAINT "valid_budget" CHECK (amount > 0 AND "warningPercent" BETWEEN 1 AND 100);
ALTER TABLE "Task" ADD CONSTRAINT "valid_task_status" CHECK (status IN ('open', 'in_progress', 'completed', 'cancelled'));
ALTER TABLE "Task" ADD CONSTRAINT "valid_priority" CHECK (priority BETWEEN 1 AND 3);
ALTER TABLE "Reminder" ADD CONSTRAINT "valid_recurrence" CHECK (recurrence IN ('once', 'daily', 'weekly', 'monthly'));
ALTER TABLE "Reminder" ADD CONSTRAINT "valid_anchor" CHECK ("anchorDay" BETWEEN 1 AND 31);

-- Privileged server connections own these tables. Supabase's browser-facing API
-- must not expose personal data even if a table is accidentally added to its schema.
ALTER TABLE "Account" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Transaction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Budget" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BudgetAlert" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Task" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Reminder" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Note" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Contact" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InboxMessage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Job" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SheetSyncOutbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PendingAction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditLog" ENABLE ROW LEVEL SECURITY;
