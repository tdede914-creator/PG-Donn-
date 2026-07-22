-- Add externalRef column to Invoice (untuk simpan reference dari 3rd party gateway
-- seperti Zeppelin OrderKuota).
ALTER TABLE "Invoice" ADD COLUMN "externalRef" TEXT;

-- Optional: index untuk lookup lebih cepat (kalau tabel udah besar).
CREATE INDEX "Invoice_externalRef_idx" ON "Invoice"("externalRef");
