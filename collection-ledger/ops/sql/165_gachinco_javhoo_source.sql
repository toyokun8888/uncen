-- Add Javhoo as a Gachinco catalog source without changing existing records.

alter table cl.gachinco_tm001_master
    drop constraint gachinco_tm001_master_title_source_code_check;
alter table cl.gachinco_tm001_master
    add constraint gachinco_tm001_master_title_source_code_check
    check (title_source_code in ('shiitake', 'a_up', 'neo', 'heydouga', 'gallery', 'javhoo'));

alter table cl.gachinco_tm003_master_source_records
    drop constraint gachinco_tm003_master_source_records_source_code_check;
alter table cl.gachinco_tm003_master_source_records
    add constraint gachinco_tm003_master_source_records_source_code_check
    check (source_code in ('shiitake', 'a_up', 'neo', 'heydouga', 'gallery', 'javhoo'));

alter table cl.gachinco_tl003_master_page_logs
    drop constraint gachinco_tl003_master_page_logs_source_code_check;
alter table cl.gachinco_tl003_master_page_logs
    add constraint gachinco_tl003_master_page_logs_source_code_check
    check (source_code in ('shiitake', 'a_up', 'neo', 'heydouga', 'gallery', 'javhoo'));
