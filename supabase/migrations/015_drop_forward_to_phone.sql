-- v2 onboarding routes human-first calls via existing_number; forward_to_phone is obsolete.
alter table businesses drop column if exists forward_to_phone;
