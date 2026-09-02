export type CreateDistillationJobInput = {
  mode: "incremental" | "full_relearn" | "scheduled_incremental";
  userIds?: string[];
  timeRangeStart?: Date;
  timeRangeEnd?: Date;
  maxRecords?: number;
};
