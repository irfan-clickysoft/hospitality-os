-- A company's account statement can be opened from a private link, like a receipt. The link always shows the account as it stands when opened.
ALTER TABLE document_link DROP CONSTRAINT document_link_kind_check;
ALTER TABLE document_link ADD CONSTRAINT document_link_kind_check CHECK (kind IN ('PAYMENT','STATEMENT','ORDER','INVOICE','COMPANY_STATEMENT'));
