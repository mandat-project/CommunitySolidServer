import type { Term } from 'rdf-js';
import { getLoggerFor } from '../../logging/LogUtil';
import type { ResourceStore } from '../../storage/ResourceStore';
import { BadRequestHttpError } from '../../util/errors/BadRequestHttpError';
import { InternalServerError } from '../../util/errors/InternalServerError';
import { NotImplementedHttpError } from '../../util/errors/NotImplementedHttpError';
import { find } from '../../util/IterableUtil';
import { ACL, AS, LDP, RDF, SOLID_AS } from '../../util/Vocabularies';
import { CreatedResponseDescription } from '../output/response/CreatedResponseDescription';
import type { ResponseDescription } from '../output/response/ResponseDescription';
import type { OperationHandlerInput } from './OperationHandler';
import { OperationHandler } from './OperationHandler';
import { randomInt } from 'crypto';
import { AuxiliaryIdentifierStrategy } from '../../http/auxiliary/AuxiliaryIdentifierStrategy';
import { isContainerIdentifier, trimTrailingSlashes } from '../../util/PathUtil';
import { DataFactory, Store, Writer } from 'n3';
import { RdfDatasetRepresentation } from '../representation/RdfDatasetRepresentation';
import { CredentialsExtractor } from '../../authentication/CredentialsExtractor';
import { OperationHttpHandlerInput } from '../../server/OperationHttpHandler';
import { RepresentationMetadata } from '../../http/representation/RepresentationMetadata';
import { BasicRepresentation } from '../../http/representation/BasicRepresentation';
import { TEXT_TURTLE } from '../../util/ContentTypes';
import { ResourceIdentifier } from '../..';

/**
 * Handles POST {@link Operation}s.
 * Calls the addResource function from a {@link ResourceStore}.
 */
export class CreatorPostOperationHandler extends OperationHandler {
  protected readonly logger = getLoggerFor(this);

  private readonly store: ResourceStore;
  private readonly creatorContainerNames: string[];
  private readonly aclStrategy: AuxiliaryIdentifierStrategy;
  private readonly credentialsExtractor: CredentialsExtractor;

  public constructor(store: ResourceStore, creatorContainerNames: string[], aclStrategy: AuxiliaryIdentifierStrategy, credentialsExtractor: CredentialsExtractor) {
    super();
    this.store = store;
    this.creatorContainerNames = creatorContainerNames;
    this.aclStrategy = aclStrategy;
    this.credentialsExtractor = credentialsExtractor;
  }

  public async canHandle({ operation }: OperationHandlerInput): Promise<void> {
    if (operation.method !== 'POST') {
      throw new NotImplementedHttpError('This handler only supports POST operations');
    }
    if (!isContainerIdentifier(operation.target)) {
      throw new NotImplementedHttpError('This handler only handles POST requests to containers');
    }
    let targetPath = trimTrailingSlashes(operation.target.path);
    let isCreatorContainer = this.creatorContainerNames.map(c => targetPath.endsWith(c)).reduce((a, b) => a || b);
    if(!isCreatorContainer) {
      throw new NotImplementedHttpError('This handler only handles creator containers specified in the config');
    }
  }

  public async handle(input: OperationHttpHandlerInput): Promise<ResponseDescription> {
    const type = new Set(input.operation.body.metadata.getAll(RDF.terms.type).map((term: Term): string => term.value));
    const isContainerType = type.has(LDP.Container) || type.has(LDP.BasicContainer);
    // Solid, §2.1: "A Solid server MUST reject PUT, POST and PATCH requests
    // without the Content-Type header with a status code of 400."
    // https://solid.github.io/specification/protocol#http-server
    // An exception is made for LDP Containers as nothing is done with the body, so a Content-type is not required
    if (!input.operation.body.metadata.contentType && !isContainerType) {
      this.logger.warn('POST requests require the Content-Type header to be set');
      throw new BadRequestHttpError('POST requests require the Content-Type header to be set');
    }
    const changes = await this.store.addResource(input.operation.target, input.operation.body, input.operation.conditions);
    const createdIdentifier = find(changes.keys(), (identifier): boolean =>
      Boolean(changes.get(identifier)?.has(SOLID_AS.terms.activity, AS.terms.Create)));
    if (!createdIdentifier) {
      throw new InternalServerError('Operation was successful but no created identifier was returned.');
    }
    const agentCredentials = await this.credentialsExtractor.handle(input.request);
    if(agentCredentials.agent) {
      const aclIdentifier = this.aclStrategy.getAuxiliaryIdentifier(createdIdentifier);
      const serializedQuads = await this.writeQuads(createdIdentifier, agentCredentials.agent.webId);
      const representation = new BasicRepresentation(serializedQuads, new RepresentationMetadata(aclIdentifier, TEXT_TURTLE));
      await this.store.setRepresentation(aclIdentifier, representation);
    }
    return new CreatedResponseDescription(createdIdentifier);
  }

  private async writeQuads(createdIdentifier: ResourceIdentifier, agentWebId: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const authorization = DataFactory.blankNode();
      const quads = [
        DataFactory.quad(authorization, DataFactory.namedNode(RDF.type) , DataFactory.namedNode(ACL.Authorization)),
        DataFactory.quad(authorization, DataFactory.namedNode(ACL.accessTo), DataFactory.namedNode(createdIdentifier.path)),
        DataFactory.quad(authorization, DataFactory.namedNode(ACL.agent), DataFactory.namedNode(agentWebId)),
        DataFactory.quad(authorization, DataFactory.namedNode(ACL.mode), DataFactory.namedNode(ACL.Read)),
      ];
      const writer = new Writer();
      writer.addQuads(quads);
      writer.end((err, result) => {
        if(err) {
          reject(err);
        } else {
          resolve(result);
        }
      })
    });
  }
}
