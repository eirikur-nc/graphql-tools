import {
  extendSchema,
  GraphQLDirective,
  GraphQLObjectType,
  GraphQLSchema,
  specifiedDirectives,
} from 'graphql';
import {
  defaultMergedResolver,
  isSubschemaConfig,
  Subschema,
  SubschemaConfig,
} from '@graphql-tools/delegate';
import { applyExtensions, mergeExtensions, mergeResolvers } from '@graphql-tools/merge';
import {
  addResolversToSchema,
  assertResolversPresent,
  extendResolversFromInterfaces,
} from '@graphql-tools/schema';
import { IResolvers } from '@graphql-tools/utils';
import { addStitchingInfo, completeStitchingInfo, createStitchingInfo } from './stitchingInfo.js';
import {
  isolateComputedFieldsTransformer,
  splitMergedTypeEntryPointsTransformer,
} from './subschemaConfigTransforms/index.js';
import { buildTypeCandidates, buildTypes } from './typeCandidates.js';
import { IStitchSchemasOptions, SubschemaConfigTransform } from './types.js';

export function stitchSchemas<TContext extends Record<string, any> = Record<string, any>>({
  subschemas = [],
  types = [],
  typeDefs = [],
  onTypeConflict,
  mergeDirectives,
  mergeTypes = true,
  typeMergingOptions,
  subschemaConfigTransforms = [],
  resolvers = {},
  inheritResolversFromInterfaces = false,
  resolverValidationOptions = {},
  updateResolversInPlace = true,
  schemaExtensions,
  ...rest
}: IStitchSchemasOptions<TContext>): GraphQLSchema {
  const transformedSubschemas: Array<Subschema<any, any, any, TContext>> = [];
  const subschemaMap: Map<
    GraphQLSchema | SubschemaConfig<any, any, any, TContext>,
    Subschema<any, any, any, TContext>
  > = new Map();
  const originalSubschemaMap: Map<
    Subschema<any, any, any, TContext>,
    GraphQLSchema | SubschemaConfig<any, any, any, TContext>
  > = new Map();

  for (const subschema of subschemas) {
    for (const transformedSubschemaConfig of applySubschemaConfigTransforms(
      subschemaConfigTransforms,
      subschema,
      subschemaMap,
      originalSubschemaMap,
    )) {
      transformedSubschemas.push(transformedSubschemaConfig);
    }
  }

  const directiveMap: Record<string, GraphQLDirective> = Object.create(null);
  for (const directive of specifiedDirectives) {
    directiveMap[directive.name] = directive;
  }
  const schemaDefs = Object.create(null);

  const [typeCandidates, rootTypeNameMap, extensions] = buildTypeCandidates({
    subschemas: transformedSubschemas,
    originalSubschemaMap,
    types,
    typeDefs: typeDefs || [],
    parseOptions: rest,
    directiveMap,
    schemaDefs,
    mergeDirectives,
  });

  let stitchingInfo = createStitchingInfo(subschemaMap, typeCandidates, mergeTypes);

  const { typeMap: newTypeMap, directives: newDirectives } = buildTypes({
    typeCandidates,
    directives: Object.values(directiveMap),
    stitchingInfo,
    rootTypeNames: Object.values(rootTypeNameMap),
    onTypeConflict,
    mergeTypes,
    typeMergingOptions,
  });

  let schema = new GraphQLSchema({
    query: newTypeMap[rootTypeNameMap.query] as GraphQLObjectType,
    mutation: newTypeMap[rootTypeNameMap.mutation] as GraphQLObjectType,
    subscription: newTypeMap[rootTypeNameMap.subscription] as GraphQLObjectType,
    types: Object.values(newTypeMap),
    directives: newDirectives,
    astNode: schemaDefs.schemaDef,
    extensionASTNodes: schemaDefs.schemaExtensions,
    extensions: null,
    assumeValid: rest.assumeValid,
  });

  for (const extension of extensions) {
    schema = extendSchema(schema, extension, {
      commentDescriptions: true,
    } as any);
  }

  // We allow passing in an array of resolver maps, in which case we merge them
  const resolverMap: IResolvers = mergeResolvers(resolvers);

  const finalResolvers = inheritResolversFromInterfaces
    ? extendResolversFromInterfaces(schema, resolverMap)
    : resolverMap;

  stitchingInfo = completeStitchingInfo(stitchingInfo, finalResolvers, schema);

  schema = addResolversToSchema({
    schema,
    defaultFieldResolver: defaultMergedResolver,
    resolvers: finalResolvers,
    resolverValidationOptions,
    inheritResolversFromInterfaces: false,
    updateResolversInPlace,
  });

  const resolverValidationOptionsEntries = Object.entries(resolverValidationOptions);

  if (
    resolverValidationOptionsEntries.length > 0 &&
    resolverValidationOptionsEntries.some(([, o]) => o !== 'ignore')
  ) {
    assertResolversPresent(schema, resolverValidationOptions);
  }

  addStitchingInfo(schema, stitchingInfo);

  if (schemaExtensions) {
    if (Array.isArray(schemaExtensions)) {
      schemaExtensions = mergeExtensions(schemaExtensions);
    }
    applyExtensions(schema, schemaExtensions);
  }

  return schema;
}

const subschemaConfigTransformerPresets: Array<SubschemaConfigTransform<any>> = [
  isolateComputedFieldsTransformer,
  splitMergedTypeEntryPointsTransformer,
];

function applySubschemaConfigTransforms<TContext = Record<string, any>>(
  subschemaConfigTransforms: Array<SubschemaConfigTransform<TContext>>,
  subschemaOrSubschemaConfig: GraphQLSchema | SubschemaConfig<any, any, any, TContext>,
  subschemaMap: Map<
    GraphQLSchema | SubschemaConfig<any, any, any, TContext>,
    Subschema<any, any, any, TContext>
  >,
  originalSubschemaMap: Map<
    Subschema<any, any, any, TContext>,
    GraphQLSchema | SubschemaConfig<any, any, any, TContext>
  >,
): Array<Subschema<any, any, any, TContext>> {
  let subschemaConfig: SubschemaConfig<any, any, any, TContext>;
  if (isSubschemaConfig(subschemaOrSubschemaConfig)) {
    subschemaConfig = subschemaOrSubschemaConfig;
  } else if (subschemaOrSubschemaConfig instanceof GraphQLSchema) {
    subschemaConfig = { schema: subschemaOrSubschemaConfig };
  } else {
    throw new TypeError('Received invalid input.');
  }

  const transformedSubschemaConfigs = subschemaConfigTransforms
    .concat(subschemaConfigTransformerPresets)
    .reduce(
      (transformedSubschemaConfigs, subschemaConfigTransform) =>
        transformedSubschemaConfigs.flatMap(ssConfig => subschemaConfigTransform(ssConfig)),
      [subschemaConfig],
    );

  const transformedSubschemas = transformedSubschemaConfigs.map(
    ssConfig => new Subschema<any, any, any, TContext>(ssConfig),
  );

  const baseSubschema = transformedSubschemas[0];

  subschemaMap.set(subschemaOrSubschemaConfig, baseSubschema);

  for (const subschema of transformedSubschemas) {
    originalSubschemaMap.set(subschema, subschemaOrSubschemaConfig);
  }

  return transformedSubschemas;
}
