# summary

Migrate ContentDocument files between Salesforce orgs.

# description

Downloads files (ContentVersions) from a source org and uploads them to a target org, linking them to matching records via a configurable match field. Supports both flag-driven and interactive modes — run with all flags for scripted execution, or run without flags for an interactive menu.

# examples

- Migrate Account files with an external ID match field:

  <%= config.bin %> <%= command.id %> --source-org source-sandbox --target-org target-prod --object Account --match-field External_Id__c

- Dry run to preview without writing:

  <%= config.bin %> <%= command.id %> --source-org source --target-org target --object Case --match-field CaseNumber --dry-run

- Interactive mode (prompts for all options):

  <%= config.bin %> <%= command.id %>

# flags.source-org.summary

Org to migrate files FROM (username or alias).

# flags.target-org.summary

Org to migrate files TO (username or alias).

# flags.object.summary

Source object API name (e.g., Account, Case, Custom_Object__c).

# flags.match-field.summary

Field to match records between orgs (e.g., External_Id__c, Name, CaseNumber).

# flags.where.summary

Optional SOQL WHERE clause to filter source records.

# flags.dry-run.summary

Preview migration without making changes to the target org.
