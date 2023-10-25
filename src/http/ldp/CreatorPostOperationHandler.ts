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
import { AuxiliaryIdentifierStrategy } from '../../http/auxiliary/AuxiliaryIdentifierStrategy';
import { isContainerIdentifier, trimTrailingSlashes } from '../../util/PathUtil';
import { DataFactory, Quad, Store, Writer } from 'n3';
import { CredentialsExtractor } from '../../authentication/CredentialsExtractor';
import { OperationHttpHandlerInput } from '../../server/OperationHttpHandler';
import { RepresentationMetadata } from '../../http/representation/RepresentationMetadata';
import { BasicRepresentation } from '../../http/representation/BasicRepresentation';
import { INTERNAL_QUADS, TEXT_TURTLE } from '../../util/ContentTypes';
import { ResourceIdentifier } from '../representation/ResourceIdentifier';
import { ResourceSet } from '../../storage/ResourceSet';
import { IdentifierStrategy } from '../../util/identifiers/IdentifierStrategy';
import { ForbiddenHttpError } from '../../util/errors/ForbiddenHttpError';
import { createErrorMessage, readableToQuads } from '../..';

/**
 * Handles POST {@link Operation}s.
 * Calls the addResource function from a {@link ResourceStore}.
 */
export class CreatorPostOperationHandler extends OperationHandler {
  protected readonly logger = getLoggerFor(this);

  private readonly store: ResourceStore;
  private readonly creatorContainerNamesAndModes: any[];
  private readonly aclStrategy: AuxiliaryIdentifierStrategy;
  private readonly credentialsExtractor: CredentialsExtractor;
  private readonly resourceSet: ResourceSet;
  private readonly identifierStrategy: IdentifierStrategy;
  private readonly aclStore: ResourceStore;

  public constructor(
    store: ResourceStore,
    creatorContainerNamesAndModes: any[],
    aclStrategy: AuxiliaryIdentifierStrategy,
    credentialsExtractor: CredentialsExtractor,
    resourceSet: ResourceSet,
    identifierStrategy: IdentifierStrategy,
    aclStore: ResourceStore
  ) {
    super();
    this.store = store;
    this.creatorContainerNamesAndModes = creatorContainerNamesAndModes;
    this.aclStrategy = aclStrategy;
    this.credentialsExtractor = credentialsExtractor;
    this.resourceSet = resourceSet;
    this.identifierStrategy = identifierStrategy;
    this.aclStore = aclStore;
  }

  public async canHandle({ operation }: OperationHandlerInput): Promise<void> {
    if (operation.method !== 'POST') {
      throw new NotImplementedHttpError('This handler only supports POST operations');
    }
    if (!isContainerIdentifier(operation.target)) {
      throw new NotImplementedHttpError('This handler only handles POST requests to containers');
    }
    
    // Check whether the container identifier ends with one of the configured strings to see if we are responsible
    let targetPath = trimTrailingSlashes(operation.target.path);
    let creatorContainer = this.creatorContainerNamesAndModes.find(([c, _]) => targetPath.endsWith(c));
    if(!creatorContainer) {
      throw new NotImplementedHttpError('This handler only handles creator containers specified in the config');
    }
  }

  public async handle(input: OperationHttpHandlerInput): Promise<ResponseDescription> {
    // Solid stuff that the normal POST handler also does
    const type = new Set(input.operation.body.metadata.getAll(RDF.terms.type).map((term: Term): string => term.value));
    const isContainerType = type.has(LDP.Container) || type.has(LDP.BasicContainer);
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

    // We need the WebId of the agent that executed the POST request
    const agentCredentials = await this.credentialsExtractor.handle(input.request);

    if(agentCredentials.agent) {
      // Create quads for ACL with configured access rights for agent the executed the POST request
      let targetPath = trimTrailingSlashes(input.operation.target.path);
      let accessModes = this.creatorContainerNamesAndModes.find(([c, _]) => targetPath.endsWith(c))![1];
      const authorization = DataFactory.blankNode();
      let accessModeQuads: Quad[] = accessModes.map((m: any) => DataFactory.quad(authorization, DataFactory.namedNode(ACL.mode), DataFactory.namedNode(ACL.namespace + (m as String))));
      const quads = [
        DataFactory.quad(authorization, DataFactory.namedNode(RDF.type) , DataFactory.namedNode(ACL.Authorization)),
        DataFactory.quad(authorization, DataFactory.namedNode(ACL.accessTo), DataFactory.namedNode(createdIdentifier.path)),
        DataFactory.quad(authorization, DataFactory.namedNode(ACL.agent), DataFactory.namedNode(agentCredentials.agent.webId)),
      ].concat(accessModeQuads);

      // Look for the ACL that currently is the effective ACL for the newly created resource and parse the triples
      // to be able to copy the currently existing access rights to the new ACL
      const effectiveAclIdentifier = await this.getAclRecursive(createdIdentifier);
      let contents: Store;
      try {
        const data = await this.aclStore.getRepresentation(effectiveAclIdentifier, { type: { [INTERNAL_QUADS]: 1 }});
        contents = await readableToQuads(data.data);
      } catch (error: unknown) {
        // Something is wrong with the server if we can't read the resource
        const message = `Error reading ACL resource ${effectiveAclIdentifier.path}: ${createErrorMessage(error)}`;
        this.logger.error(message);
        throw new InternalServerError(message, { cause: error });
      }

      // From the old effective ACL throw away all triples with predicate acl:access as they were not meant for the
      // new resource. acl:default on the other hand affect the new resource so they become _:authorization acl:accessTo
      // <URI of newresource> .
      const subject = this.aclStrategy.getSubjectIdentifier(effectiveAclIdentifier);
      if(createdIdentifier.path !== subject.path) {
        const authorizations = contents.getSubjects(DataFactory.namedNode(ACL.default), null, null);
        for(let a of authorizations) {
          let aBlank = DataFactory.blankNode();
          for(let q of contents.getQuads(a, null, null, null)) {
            if(q.predicate.equals(DataFactory.namedNode(ACL.default))) {
              quads.push(DataFactory.quad(aBlank, DataFactory.namedNode(ACL.accessTo), DataFactory.namedNode(createdIdentifier.path)));
            } else if(!q.predicate.equals(DataFactory.namedNode(ACL.accessTo))) {
              quads.push(DataFactory.quad(aBlank, q.predicate, q.object));
            }
          }
        }
      }

      // Write quads to ACL for new resource
      const aclIdentifier = this.aclStrategy.getAuxiliaryIdentifier(createdIdentifier);
      const serializedQuads = await this.writeQuads(quads);
      const representation = new BasicRepresentation(serializedQuads, new RepresentationMetadata(aclIdentifier, TEXT_TURTLE));
      await this.store.setRepresentation(aclIdentifier, representation);
    }
    return new CreatedResponseDescription(createdIdentifier);
  }

  /*
    Auxiliary method for serializing quads without callback
  */
  private async writeQuads(quads: Quad[]): Promise<string> {
    return new Promise((resolve, reject) => {
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

  /*
    Auxiliary method for finding the effective ACL of a resource. Copied from another class...
  */
  private async getAclRecursive(identifier: ResourceIdentifier): Promise<ResourceIdentifier> {
    // Obtain the direct ACL document for the resource, if it exists
    this.logger.debug(`Trying to read the direct ACL document of ${identifier.path}`);

    const acl = this.aclStrategy.getAuxiliaryIdentifier(identifier);
    this.logger.debug(`Determining existence of  ${acl.path}`);
    if (await this.resourceSet.hasResource(acl)) {
      this.logger.info(`Found applicable ACL document ${acl.path}`);
      return acl;
    }
    this.logger.debug(`No direct ACL document found for ${identifier.path}`);

    // Find the applicable ACL document of the parent container
    this.logger.debug(`Traversing to the parent of ${identifier.path}`);
    if (this.identifierStrategy.isRootContainer(identifier)) {
      this.logger.error(`No ACL document found for root container ${identifier.path}`);
      // https://solidproject.org/TR/2021/wac-20210711#acl-resource-representation
      // The root container MUST have an ACL resource with a representation.
      throw new ForbiddenHttpError('No ACL document found for root container');
    }
    const parent = this.identifierStrategy.getParentContainer(identifier);
    return this.getAclRecursive(parent);
  }
}
