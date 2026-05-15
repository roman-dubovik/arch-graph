export interface ProjectConfig {
    id: string;
    root: string;
    appsGlob: string;
    libsGlob?: string;
    wrapperPublishApis: WrapperApi[];
    wrapperSubscribeApis: WrapperApi[];
    excludeGlobs?: string[];
}

export interface WrapperApi {
    class: string;
    methods: string[];
}

export interface SourceLoc {
    file: string;
    line: number;
    column: number;
}

export type EdgeKind = 'nats-publish' | 'nats-request' | 'nats-subscribe' | 'nats-reply';

export type ResolvedSubject =
    | { kind: 'literal'; value: string }
    | { kind: 'pattern'; pattern: string; placeholders: string[] }
    | { kind: 'dynamic'; hint: string }
    | { kind: 'unresolved'; raw: string; reason: string };

export interface NatsCallSite {
    role: 'sender' | 'receiver';
    edgeKind: EdgeKind;
    subject: ResolvedSubject;
    location: SourceLoc;
    via: string; // "ClientProxy.emit", "@MessagePattern", "PlatformConnectionService.request" ...
    enclosingClass?: string;
    enclosingService?: string;
}

export interface GroundTruthEntry {
    role: 'sender' | 'receiver';
    location: SourceLoc;
    matchedText: string;
    context: string; // detected via (decorator type, method name, etc.)
}

export interface ValidationReport {
    projectId: string;
    timestamp: string;
    summary: {
        recallHandlers: number; // 0..1
        recallSenders: number;
        resolveRate: number;
        /** literal + pattern + dynamic / total — i.e. extractor correctly classified, no bugs */
        classificationAccuracy: number;
        totalExtracted: number;
        totalGroundTruth: number;
        bySubjectKind: Record<string, number>;
    };
    extracted: NatsCallSite[];
    groundTruth: GroundTruthEntry[];
    missed: GroundTruthEntry[]; // in ground truth, NOT in extracted
    extra: NatsCallSite[]; // in extracted, NOT in ground truth (possibly false positive)
    unresolvedSamples: NatsCallSite[]; // for human review
}
