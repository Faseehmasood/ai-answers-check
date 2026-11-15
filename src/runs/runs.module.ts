import { Module } from '@nestjs/common';
import { RunsService } from './runs.service.js';
import { InMemoryRunsRepository } from './in-memory-runs.repository.js';

export const RUNS_REPOSITORY = 'RUNS_REPOSITORY';

@Module({
  providers: [
    {
      provide: RUNS_REPOSITORY,
      useClass: InMemoryRunsRepository,
    },
    {
      provide: RunsService,
      useFactory: (repo) => new RunsService(repo),
      inject: [RUNS_REPOSITORY],
    },
  ],
  exports: [RunsService, RUNS_REPOSITORY],
})
export class RunsModule {}
