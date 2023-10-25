# Creator Post Handler
A handler for POST requests (creating a resource) that allows the creator of the resource to automatically have access to the resource by creating the corresponding ACL

## Config
The handlers we are interested in are configured in [config/ldp/handlers/components/operation-handler.json](config/ldp/handler/components/operation-handler.json). We copied the file to [config/ldp/handlers/components/operation-handler-with-creator.json](config/ldp/handler/components/operation-handler-with-creator.json) and added a `CreatorPostOperationHandler` to the waterfall handler before the normal `PostOperationHandler`.

The `CreatorPostOperationHandler` is configured as follows: Under `creatorContainerNamesAndModes` we can add an array of pairs where the first element of the pair is the name of the container to which the handler should apply and the second element of the pair is a list of ACL access modes that should be given to the creator of resources in this container.

To use [config/ldp/handlers/components/operation-handler-with-creator.json](config/ldp/handler/components/operation-handler-with-creator.json) instead of [config/ldp/handlers/components/operation-handler.json](config/ldp/handler/components/operation-handler.json) we also created the config file [config/ldp/handler/with-creator.json](config/ldp/handler/with-creator.json) as alternative to [config/ldp/handler/default.json](config/ldp/handler/default.json) and added it to the provided global config files (e.g. [config/default.json](config/default.json), [config/file.json](config/file.json)).

## Code
All implementation has been done in the class [src/http/ldp/CreatorPostOperationHandler.ts](src/http/ldp/CreatorPostOperationHandler.ts).

## Contributors
[dschraudner](https://github.com/dschraudner), [se-schmid](https://github.com/se-schmid), [kaefer3000](https://github.com/kaefer3000)