/*
* expressionEvaluator.ts
* Copyright (c) Microsoft Corporation.
* Licensed under the MIT license.
* Author: Eric Traut
*
* Class that evaluates the type of expressions (parse trees)
* within particular contexts and reports type errors.
*/

import * as assert from 'assert';

import { ConfigOptions, DiagnosticLevel, ExecutionEnvironment } from '../common/configOptions';
import { DiagnosticAddendum } from '../common/diagnostic';
import { TextRangeDiagnosticSink } from '../common/diagnosticSink';
import { PythonVersion } from '../common/pythonVersion';
import StringMap from '../common/stringMap';
import { TextRange } from '../common/textRange';
import { ArgumentCategory, AssignmentNode, AwaitExpressionNode,
    BinaryExpressionNode, CallExpressionNode, ClassNode, ConstantNode,
    DecoratorNode, DictionaryNode, EllipsisNode, ExpressionNode,
    IndexExpressionNode, IndexItemsNode, LambdaNode, ListComprehensionNode,
    ListNode, MemberAccessExpressionNode, NameNode, NumberNode, ParameterCategory,
    ParseNode, SetNode, SliceExpressionNode, StatementListNode,
    StringNode, TernaryExpressionNode, TupleExpressionNode, TypeAnnotationExpressionNode,
    UnaryExpressionNode, UnpackExpressionNode, YieldExpressionNode,
    YieldFromExpressionNode } from '../parser/parseNodes';
import { KeywordToken, KeywordType, OperatorType, QuoteTypeFlags,
    TokenType } from '../parser/tokenizerTypes';
import { ScopeUtils } from '../scopeUtils';
import { AnalyzerNodeInfo } from './analyzerNodeInfo';
import { DefaultTypeSourceId } from './inferredType';
import { ParseTreeUtils } from './parseTreeUtils';
import { Scope, ScopeType } from './scope';
import { Symbol, SymbolCategory } from './symbol';
import { ConditionalTypeConstraintResults, TypeConstraint,
    TypeConstraintBuilder } from './typeConstraint';
import { AnyType, ClassType, ClassTypeFlags, FunctionParameter, FunctionType,
    FunctionTypeFlags, ModuleType, NeverType, NoneType, ObjectType,
    OverloadedFunctionType, PropertyType, Type, TypeVarMap, TypeVarType,
    UnionType, UnknownType } from './types';
import { ClassMember, TypeUtils } from './typeUtils';

interface TypeResult {
    type: Type;
    typeList?: TypeResult[];
    node: ExpressionNode;
}

interface FunctionArgument {
    valueExpression?: ExpressionNode;
    argumentCategory: ArgumentCategory;
    name?: NameNode;
    type: Type;
}

export enum EvaluatorFlags {
    None = 0,

    // Interpret a class type as a instance of that class. This
    // is the normal mode used for type annotations.
    ConvertClassToObject = 1,

    // Interpret an ellipsis type annotation to mean "Any".
    ConvertEllipsisToAny = 2,

    // Normally a generic named type is specialized with "Any"
    // types. This flag indicates that specialization shouldn't take
    // place.
    DoNotSpecialize = 4
}

export enum EvaluatorUsage {
    // The expression is being read.
    Get,

    // The expression is being written.
    Set,

    // The expression is being deleted.
    Delete
}

export enum MemberAccessFlags {
    None = 0,

    // By default, both class and instance members are considered.
    // Set this flag to skip the instance members.
    SkipInstanceMembers = 1,

    // By default, members of base classes are also searched.
    // Set this flag to consider only the specified class' members.
    SkipBaseClasses = 2,

    // Do not include the "object" base class in the search.
    SkipObjectBaseClass = 4,

    // By default, if the class has a __getattribute__ or __getattr__
    // magic method, it is assumed to have any member.
    SkipGetAttributeCheck = 8,

    // By default, if the class has a __get__ magic method, this is
    // followed to determine the final type. Properties use this
    // technique.
    SkipGetCheck = 16,

    // This set of flags is appropriate for looking up methods.
    SkipForMethodLookup = SkipInstanceMembers | SkipGetAttributeCheck | SkipGetCheck
}

interface ParamAssignmentInfo {
    argsNeeded: number;
    argsReceived: number;
}

export type ReadTypeFromNodeCacheCallback = (node: ExpressionNode) => Type | undefined;
export type WriteTypeToNodeCacheCallback = (node: ExpressionNode, type: Type) => void;

export class ExpressionEvaluator {
    private _scope: Scope;
    private _configOptions: ConfigOptions;
    private _executionEnvironment: ExecutionEnvironment;
    private _expressionTypeConstraints: TypeConstraint[] = [];
    private _diagnosticSink?: TextRangeDiagnosticSink;
    private _readTypeFromCache?: ReadTypeFromNodeCacheCallback;
    private _writeTypeToCache?: WriteTypeToNodeCacheCallback;

    constructor(scope: Scope, configOptions: ConfigOptions,
            executionEnvironment: ExecutionEnvironment,
            diagnosticSink?: TextRangeDiagnosticSink,
            readTypeCallback?: ReadTypeFromNodeCacheCallback,
            writeTypeCallback?: WriteTypeToNodeCacheCallback) {
        this._scope = scope;
        this._configOptions = configOptions;
        this._executionEnvironment = executionEnvironment;
        this._diagnosticSink = diagnosticSink;
        this._readTypeFromCache = readTypeCallback;
        this._writeTypeToCache = writeTypeCallback;
    }

    getType(node: ExpressionNode, usage: EvaluatorUsage, flags: EvaluatorFlags): Type {
        let typeResult = this._getTypeFromExpression(node, usage, flags);
        return typeResult.type;
    }

    getTypeFromDecorator(node: DecoratorNode, functionType: Type): Type {
        const baseTypeResult = this._getTypeFromExpression(
            node.leftExpression, EvaluatorUsage.Get, EvaluatorFlags.DoNotSpecialize);

        let decoratorCall = baseTypeResult;

        // If the decorator has arguments, evaluate that call first.
        if (node.arguments) {
            const argList = node.arguments.map(arg => {
                return {
                    valueExpression: arg.valueExpression,
                    argumentCategory: arg.argumentCategory,
                    name: arg.name,
                    type: this._getTypeFromExpression(arg.valueExpression,
                        EvaluatorUsage.Get, EvaluatorFlags.None).type
                };
            });

            decoratorCall = this._getTypeFromCallExpressionWithBaseType(
                node.leftExpression, argList, decoratorCall, EvaluatorFlags.None);
        }

        const argList = [{
            argumentCategory: ArgumentCategory.Simple,
            type: functionType
        }];

        return this._getTypeFromCallExpressionWithBaseType(
            node.leftExpression, argList, decoratorCall, EvaluatorFlags.None).type;
    }

    // Gets a member type from an object and if it's a function binds
    // it to the object.
    getTypeFromObjectMember(memberName: string, usage: EvaluatorUsage,
            objectType: ObjectType): Type | undefined {

        const memberType = this._getTypeFromClassMemberName(
            objectType.getClassType(), memberName, usage, MemberAccessFlags.None);

        let resultType = memberType;
        if (memberType instanceof FunctionType || memberType instanceof OverloadedFunctionType) {
            resultType = TypeUtils.bindFunctionToClassOrObject(objectType, memberType);
        }

        return resultType;
    }

    // Applies an "await" operation to the specified type and returns
    // the result. According to PEP 492, await operates on:
    // 1) a generator object
    // 2) an Awaitable (object that provides an __await__ that
    //    returns a generator object)
    getTypeFromAwaitable(type: Type, errorNode: ParseNode): Type {
        return TypeUtils.doForSubtypes(type, subtype => {
            if (subtype.isAny()) {
                return UnknownType.create();
            }

            const generatorReturnType = this._getReturnTypeFromGenerator(subtype);
            if (generatorReturnType) {
                return generatorReturnType;
            }

            if (subtype instanceof ObjectType) {
                const awaitReturnType = this._getSpecializedReturnType(
                    subtype, '__await__');
                if (awaitReturnType) {
                    if (awaitReturnType.isAny()) {
                        return UnknownType.create();
                    }

                    if (awaitReturnType instanceof ObjectType) {
                        const iterReturnType = this._getSpecializedReturnType(
                            awaitReturnType, '__iter__');

                        if (iterReturnType) {
                            const generatorReturnType = this._getReturnTypeFromGenerator(
                                awaitReturnType);
                            if (generatorReturnType) {
                                return generatorReturnType;
                            }
                        }
                    }
                }
            }

            this._addError(`'${ subtype.asString() }' is not awaitable`, errorNode);

            return UnknownType.create();
        });
    }

    // Validates that the type is iterable and returns the iterated type.
    getTypeFromIterable(type: Type, isAsync: boolean, errorNode: ParseNode): Type {
        const iterMethodName = isAsync ? '__aiter__' : '__iter__';
        const nextMethodName = isAsync ? '__anext__' : '__next__';

        // TODO - tighten this up, perhaps with a configuration switch.
        if (type instanceof UnionType) {
            type = type.removeOptional();
        }

        return TypeUtils.doForSubtypes(type, subtype => {
            if (subtype.isAny()) {
                return UnknownType.create();
            }

            let diag = new DiagnosticAddendum();
            if (subtype instanceof ObjectType) {
                const iterReturnType = this._getSpecializedReturnType(
                    subtype, iterMethodName);
                if (!iterReturnType) {
                    diag.addMessage(`'${ iterMethodName }' method not defined`);
                } else {
                    if (iterReturnType.isAny()) {
                        return UnknownType.create();
                    }

                    if (iterReturnType instanceof ObjectType) {
                        const nextReturnType = this._getSpecializedReturnType(
                            iterReturnType, nextMethodName);

                        if (!nextReturnType) {
                            diag.addMessage(`'${ nextMethodName }' method not defined on type ` +
                                `'${ iterReturnType.asString() }'`);
                        } else {
                            if (!isAsync) {
                                return nextReturnType;
                            }

                            // If it's an async iteration, there's an implicit
                            // 'await' operator applied.
                            return this.getTypeFromAwaitable(nextReturnType, errorNode);
                        }
                    } else {
                        diag.addMessage(`'${ iterMethodName }' method does not return an object`);
                    }
                }
            } else {
                // TODO - handle other types including Tuple and ClassType.
                return UnknownType.create();
            }

            this._addError(`'${ subtype.asString() }' is not iterable` + diag.getString(),
                errorNode);

            return UnknownType.create();
        });
    }

    // Validates fields for compatibility with a dataclass and synthesizes
    // an appropriate __new__ and __init__ methods.
    synthesizeDataClassMethods(node: ClassNode, classType: ClassType) {
        assert(classType.isDataClass());

        let newType = new FunctionType(FunctionTypeFlags.StaticMethod);
        let initType = new FunctionType(FunctionTypeFlags.InstanceMethod);
        let sawDefaultValue = false;

        newType.addParameter({
            category: ParameterCategory.Simple,
            name: 'cls',
            type: classType
        });

        newType.setDeclaredReturnType(new ObjectType(classType));

        initType.addParameter({
            category: ParameterCategory.Simple,
            name: 'self',
            type: new ObjectType(classType)
        });

        node.suite.statements.forEach(statementList => {
            if (statementList instanceof StatementListNode) {
                statementList.statements.forEach(statement => {
                    let variableNameNode: NameNode | undefined;
                    let variableType: Type | undefined;
                    let hasDefaultValue = false;

                    if (statement instanceof AssignmentNode) {
                        if (statement.leftExpression instanceof NameNode) {
                            variableNameNode = statement.leftExpression;
                        } else if (statement.leftExpression instanceof TypeAnnotationExpressionNode &&
                                statement.leftExpression.valueExpression instanceof NameNode) {

                            variableNameNode = statement.leftExpression.valueExpression;
                        }

                        variableType = this.getType(statement.rightExpression,
                            EvaluatorUsage.Get, EvaluatorFlags.None);
                        hasDefaultValue = true;
                    } else if (statement instanceof TypeAnnotationExpressionNode) {
                        if (statement.valueExpression instanceof NameNode) {
                            variableNameNode = statement.valueExpression;
                            variableType = this.getType(statement.typeAnnotation, EvaluatorUsage.Get,
                                EvaluatorFlags.ConvertClassToObject | EvaluatorFlags.ConvertEllipsisToAny);
                        }
                    }

                    if (variableNameNode && variableType) {
                        const variableName = variableNameNode.nameToken.value;

                        // Python 3.7 enforces the convention that data fields within
                        // a data class cannot being with "_".
                        if (this._executionEnvironment.pythonVersion >= PythonVersion.V37) {
                            if (variableName[0] === '_') {
                                this._addError(`Data field name cannot start with _`, variableNameNode);
                            }
                        }

                        // If we've already seen a variable with a default value defined,
                        // all subsequent variables must also have default values.
                        if (!hasDefaultValue && sawDefaultValue) {
                            this._addError(`Data fields without default value cannot appear after ` +
                                `data fields with default values`, variableNameNode);
                        }

                        // Add the new variable to the init function.
                        const paramInfo: FunctionParameter = {
                            category: ParameterCategory.Simple,
                            name: variableName,
                            hasDefault: hasDefaultValue,
                            type: variableType
                        };

                        initType.addParameter(paramInfo);
                        newType.addParameter(paramInfo);

                        if (hasDefaultValue) {
                            sawDefaultValue = true;
                        }
                    }
                });
            }
        });

        classType.getClassFields().set('__init__', new Symbol(initType, DefaultTypeSourceId));
        classType.getClassFields().set('__new__', new Symbol(newType, DefaultTypeSourceId));
    }

    private _getReturnTypeFromGenerator(type: Type): Type | undefined {
        if (type.isAny()) {
            return type;
        }

        if (type instanceof ObjectType) {
            // Is this a Generator? If so, return the third
            // type argument, which is the await response type.
            const classType = type.getClassType();
            if (classType.isBuiltIn() && classType.getClassName() === 'Generator') {
                const typeArgs = classType.getTypeArguments();
                if (typeArgs && typeArgs.length >= 3) {
                    return typeArgs[2];
                }
            }
        }

        return undefined;
    }

    private _getSpecializedReturnType(objType: ObjectType, memberName: string) {
        const classMember = TypeUtils.lookUpObjectMember(objType, memberName, false);
        if (!classMember) {
            return undefined;
        }

        if (classMember.symbolType.isAny()) {
            return classMember.symbolType;
        }

        if (classMember.symbolType instanceof FunctionType) {
            let methodType = TypeUtils.bindFunctionToClassOrObject(objType,
                classMember.symbolType) as FunctionType;
            return methodType.getEffectiveReturnType();
        }

        return undefined;
    }

    private _getTypeFromExpression(node: ExpressionNode, usage: EvaluatorUsage,
            flags: EvaluatorFlags): TypeResult {

        // Is this type already cached?
        if (this._readTypeFromCache) {
            let cachedType = this._readTypeFromCache(node);
            if (cachedType) {
                return { type: cachedType, node };
            }
        }

        let typeResult: TypeResult | undefined;

        if (node instanceof NameNode) {
            typeResult = this._getTypeFromName(node, flags);
        } else if (node instanceof MemberAccessExpressionNode) {
            typeResult = this._getTypeFromMemberAccessExpression(node, usage, flags);
        } else if (node instanceof IndexExpressionNode) {
            typeResult = this._getTypeFromIndexExpression(node, usage, flags);
        } else if (node instanceof CallExpressionNode) {
            this._reportUsageErrorForReadOnly(node, usage);
            typeResult = this._getTypeFromCallExpression(node, flags);
        } else if (node instanceof TupleExpressionNode) {
            typeResult = this._getTypeFromTupleExpression(node, usage, flags);
        } else if (node instanceof ConstantNode) {
            this._reportUsageErrorForReadOnly(node, usage);
            typeResult = this._getTypeFromConstantExpression(node);
        } else if (node instanceof StringNode) {
            this._reportUsageErrorForReadOnly(node, usage);
            if (node.typeAnnotation) {
                return this._getTypeFromExpression(node.typeAnnotation, usage, flags);
            }

            let isBytes = (node.tokens[0].quoteTypeFlags & QuoteTypeFlags.Byte) !== 0;
            typeResult = this._getBuiltInTypeFromLiteralExpression(node,
                isBytes ? 'byte' : 'str');
        } else if (node instanceof NumberNode) {
            this._reportUsageErrorForReadOnly(node, usage);
            typeResult = this._getBuiltInTypeFromLiteralExpression(node,
                node.token.isInteger ? 'int' : 'float');
        } else if (node instanceof EllipsisNode) {
            this._reportUsageErrorForReadOnly(node, usage);
            const convertToAny = (flags & EvaluatorFlags.ConvertEllipsisToAny) !== 0;
            typeResult = { type: AnyType.create(!convertToAny), node };
        } else if (node instanceof UnaryExpressionNode) {
            this._reportUsageErrorForReadOnly(node, usage);
            typeResult = this._getTypeFromUnaryExpression(node, flags);
        } else if (node instanceof BinaryExpressionNode) {
            this._reportUsageErrorForReadOnly(node, usage);
            typeResult = this._getTypeFromBinaryExpression(node, flags);
        } else if (node instanceof ListNode) {
            typeResult = this._getTypeFromListExpression(node, usage);
        } else if (node instanceof SliceExpressionNode) {
            this._reportUsageErrorForReadOnly(node, usage);
            typeResult = this._getTypeFromSliceExpression(node, flags);
        } else if (node instanceof AwaitExpressionNode) {
            typeResult = this._getTypeFromExpression(
                node.expression, EvaluatorUsage.Get, flags);
            typeResult = {
                type: this.getTypeFromAwaitable(typeResult.type, node.expression),
                node
            };
        } else if (node instanceof TernaryExpressionNode) {
            this._reportUsageErrorForReadOnly(node, usage);
            typeResult = this._getTypeFromTernaryExpression(node, flags);
        } else if (node instanceof ListComprehensionNode) {
            this._reportUsageErrorForReadOnly(node, usage);
            typeResult = this._getTypeFromListComprehensionExpression(node);
        } else if (node instanceof DictionaryNode) {
            this._reportUsageErrorForReadOnly(node, usage);
            typeResult = this._getTypeFromDictionaryExpression(node);
        } else if (node instanceof LambdaNode) {
            this._reportUsageErrorForReadOnly(node, usage);
            typeResult = this._getTypeFromLambdaExpression(node);
        } else if (node instanceof SetNode) {
            this._reportUsageErrorForReadOnly(node, usage);
            typeResult = this._getTypeFromSetExpression(node);
        } else if (node instanceof AssignmentNode) {
            this._reportUsageErrorForReadOnly(node, usage);

            // Don't validate the type match for the assignment here. Simply
            // return the type result of the RHS.
            typeResult = this._getTypeFromExpression(node.rightExpression,
                EvaluatorUsage.Get, EvaluatorFlags.None);
        } else if (node instanceof YieldExpressionNode) {
            this._reportUsageErrorForReadOnly(node, usage);
            typeResult = this._getTypeFromYieldExpression(node);
        } else if (node instanceof YieldFromExpressionNode) {
            this._reportUsageErrorForReadOnly(node, usage);
            typeResult = this._getTypeFromYieldFromExpression(node);
        } else if (node instanceof UnpackExpressionNode) {
            // TODO - need to implement
            this._getTypeFromExpression(node.expression, usage, EvaluatorFlags.None);
            // TODO - need to handle futures
            let type = UnknownType.create();
            typeResult = { type, node };
        } else if (node instanceof TypeAnnotationExpressionNode) {
            typeResult = this._getTypeFromExpression(node.typeAnnotation,
                EvaluatorUsage.Get, EvaluatorFlags.None);
        }

        if (typeResult) {
            typeResult.type = this._applyTypeConstraint(node, typeResult.type);
        } else {
            // We shouldn't get here. If we do, report an error.
            this._addError(`Unhandled expression type '${ ParseTreeUtils.printExpression(node) }'`, node);
            typeResult = { type: UnknownType.create(), node };
        }

        if (this._writeTypeToCache) {
            this._writeTypeToCache(node, typeResult.type);
        }

        return typeResult;
    }

    private _getTypeFromName(node: NameNode, flags: EvaluatorFlags): TypeResult {
        const name = node.nameToken.value;
        let type: Type | undefined;

        // Look for the scope that contains the value definition and
        // see if it has a declared type.
        const symbolWithScope = this._scope.lookUpSymbolRecursive(name);

        if (symbolWithScope) {
            const symbol = symbolWithScope.symbol;

            let declaration = symbol.declarations ? symbol.declarations[0] : undefined;

            if (declaration && declaration.declaredType) {
                // Was there a defined type hint?
                type = declaration.declaredType;
            } else if (declaration && declaration.category !== SymbolCategory.Variable) {
                // If this is a non-variable type (e.g. a class, function, method), we
                // can assume that it's not going to be modified outside the local scope.
                type = symbol.currentType;
            } else {
                type = symbol.inferredType.getType();
            }
        }

        if (!type) {
            this._addError(`'${ name }' is not defined`, node);
            type = UnknownType.create();
        }

        // Should we specialize the class?
        if ((flags & EvaluatorFlags.DoNotSpecialize) === 0) {
            if (type instanceof ClassType) {
                type = this._createSpecializeClassType(type, undefined, node, flags);
            }
        }

        type = this._convertClassToObjectConditional(type, flags);

        return { type, node };
    }

    private _getTypeFromMemberAccessExpression(node: MemberAccessExpressionNode,
            usage: EvaluatorUsage, flags: EvaluatorFlags): TypeResult {

        const baseTypeResult = this._getTypeFromExpression(
            node.leftExpression, EvaluatorUsage.Get, EvaluatorFlags.None);
        const memberType = this._getTypeFromMemberAccessExpressionWithBaseType(
            node, baseTypeResult, usage, flags);

        if (this._writeTypeToCache) {
            // Cache the type information in the member name node as well.
            this._writeTypeToCache(node.memberName, memberType.type);
        }

        return memberType;
    }

    private _getTypeFromMemberAccessExpressionWithBaseType(node: MemberAccessExpressionNode,
                baseTypeResult: TypeResult, usage: EvaluatorUsage,
                flags: EvaluatorFlags): TypeResult {

        const baseType = baseTypeResult.type;
        const memberName = node.memberName.nameToken.value;

        let type: Type | undefined;

        if (baseType.isAny()) {
            type = baseType;
        } else if (baseType instanceof ClassType) {
            type = this._getTypeFromClassMemberName(baseType, node.memberName.nameToken.value,
                usage, MemberAccessFlags.SkipInstanceMembers);
            if (type) {
                type = TypeUtils.bindFunctionToClassOrObject(baseType, type);
            }
        } else if (baseType instanceof ObjectType) {
            type = this._getTypeFromClassMemberName(baseType.getClassType(),
                node.memberName.nameToken.value, usage, MemberAccessFlags.None);
            if (type) {
                type = TypeUtils.bindFunctionToClassOrObject(baseType, type);
            }
        } else if (baseType instanceof ModuleType) {
            let memberInfo = baseType.getFields().get(memberName);
            if (memberInfo) {
                type = memberInfo.currentType;
            } else {
                this._addError(`'${ memberName }' is not a known member of module`, node.memberName);
                type = UnknownType.create();
            }
        } else if (baseType instanceof UnionType) {
            let returnTypes: Type[] = [];
            baseType.getTypes().forEach(typeEntry => {
                if (typeEntry instanceof NoneType) {
                    this._addDiagnostic(
                        this._configOptions.reportOptionalMemberAccess,
                        `'${ memberName }' is not a known member of 'None'`, node.memberName);
                } else {
                    let typeResult = this._getTypeFromMemberAccessExpressionWithBaseType(node,
                        {
                            type: typeEntry,
                            node
                        },
                        usage,
                        EvaluatorFlags.None);

                    if (typeResult) {
                        returnTypes.push(typeResult.type);
                    }
                }
            });

            if (returnTypes.length > 0) {
                type = TypeUtils.combineTypes(returnTypes);
            }
        } else if (baseType instanceof PropertyType) {
            if (memberName === 'getter' || memberName === 'setter' || memberName === 'deleter') {
                // Synthesize a decorator.
                const decoratorType = new FunctionType(FunctionTypeFlags.InstanceMethod);
                decoratorType.addParameter({
                    category: ParameterCategory.Simple,
                    name: 'fn',
                    type: UnknownType.create()
                });
                decoratorType.setDeclaredReturnType(baseType);
                type = decoratorType;
            }
        } else if (baseType instanceof FunctionType || baseType instanceof OverloadedFunctionType) {
            // TODO - not yet sure what to do about members of functions,
            // which have associated dictionaries.
            type = UnknownType.create();
        }

        if (!type) {
            let operationName = 'access';
            if (usage === EvaluatorUsage.Set) {
                operationName = 'set';
            } else if (usage === EvaluatorUsage.Delete) {
                operationName = 'delete';
            }

            this._addError(
                `Cannot ${ operationName } member '${ memberName }' for type '${ baseType.asString() }'`,
                node.memberName);
            type = UnknownType.create();
        }

        // Should we specialize the class?
        if ((flags & EvaluatorFlags.DoNotSpecialize) === 0) {
            if (type instanceof ClassType) {
                type = this._createSpecializeClassType(type, undefined, node, flags);
            }
        }

        type = this._convertClassToObjectConditional(type, flags);

        return { type, node };
    }

    private _getTypeFromClassMemberName(classType: ClassType, memberName: string,
            usage: EvaluatorUsage, flags: MemberAccessFlags): Type | undefined {

        // If this is a special type (like "List") that has an alias
        // class (like "list"), switch to the alias, which defines
        // the members.
        const aliasClass = classType.getAliasClass();
        if (aliasClass) {
            classType = aliasClass;
        }

        let memberInfo = TypeUtils.lookUpClassMember(classType, memberName,
            !(flags & MemberAccessFlags.SkipInstanceMembers),
            !(flags & MemberAccessFlags.SkipBaseClasses));

        if (memberInfo) {
            // Should we ignore members on the 'object' base class?
            if (flags & MemberAccessFlags.SkipObjectBaseClass) {
                if (memberInfo.classType instanceof ClassType) {
                    const classType = memberInfo.classType;
                    if (classType.isBuiltIn() && classType.getClassName() === 'object') {
                        memberInfo = undefined;
                    }
                }
            }
        }

        if (memberInfo) {
            let type = memberInfo.symbolType;

            if (!(flags & MemberAccessFlags.SkipGetCheck)) {
                if (type instanceof PropertyType) {
                    if (usage === EvaluatorUsage.Get) {
                        return type.getEffectiveReturnType();
                    } else if (usage === EvaluatorUsage.Set) {
                        // The type isn't important for set or delete usage.
                        // We just need to return some defined type.
                        return type.hasSetter() ? AnyType.create() : undefined;
                    } else {
                        assert(usage === EvaluatorUsage.Delete);
                        return type.hasDeleter() ? AnyType.create() : undefined;
                    }
                } else if (type instanceof ObjectType) {
                    // See if there's a magic "__get__", "__set__", or "__delete__"
                    // method on the object.
                    let accessMethodName: string;

                    if (usage === EvaluatorUsage.Get) {
                        accessMethodName = '__get__';
                    } else if (usage === EvaluatorUsage.Set) {
                        accessMethodName = '__set__';
                    } else {
                        accessMethodName = '__del__';
                    }

                    const memberClassType = type.getClassType();
                    let getMember = TypeUtils.lookUpClassMember(memberClassType, accessMethodName, false);
                    if (getMember) {
                        if (getMember.symbolType instanceof FunctionType) {
                            if (usage === EvaluatorUsage.Get) {
                                type = getMember.symbolType.getEffectiveReturnType();
                            } else {
                                // The type isn't important for set or delete usage.
                                // We just need to return some defined type.
                                type = AnyType.create();
                            }
                        }
                    }
                }
            }

            return type;
        }

        if (!(flags & MemberAccessFlags.SkipGetAttributeCheck)) {
            if (usage === EvaluatorUsage.Get) {
                // See if the class has a "__getattribute__" or "__getattr__" method.
                // If so, arbitrary members are supported.
                let getAttribType = this._getTypeFromClassMemberName(classType,
                    '__getattribute__', EvaluatorUsage.Get,
                        MemberAccessFlags.SkipForMethodLookup |
                        MemberAccessFlags.SkipObjectBaseClass);

                if (getAttribType && getAttribType instanceof FunctionType) {
                    return getAttribType.getEffectiveReturnType();
                }

                let getAttrType = this._getTypeFromClassMemberName(classType,
                    '__getattr__', EvaluatorUsage.Get, MemberAccessFlags.SkipForMethodLookup);
                if (getAttrType && getAttrType instanceof FunctionType) {
                    return getAttrType.getEffectiveReturnType();
                }
            } else if (usage === EvaluatorUsage.Set) {
                let setAttrType = this._getTypeFromClassMemberName(classType,
                    '__setattr__', EvaluatorUsage.Get, MemberAccessFlags.SkipForMethodLookup);
                if (setAttrType) {
                    // The type doesn't matter for a set usage. We just need
                    // to return a defined type.
                    return AnyType.create();
                }
            } else {
                assert(usage === EvaluatorUsage.Delete);
                let delAttrType = this._getTypeFromClassMemberName(classType,
                    '__detattr__', EvaluatorUsage.Get, MemberAccessFlags.SkipForMethodLookup);
                if (delAttrType) {
                    // The type doesn't matter for a delete usage. We just need
                    // to return a defined type.
                    return AnyType.create();
                }
            }
        }

        return undefined;
    }

    private _getTypeFromIndexExpression(node: IndexExpressionNode,
            usage: EvaluatorUsage, flags: EvaluatorFlags): TypeResult {

        const baseTypeResult = this._getTypeFromExpression(node.baseExpression,
            EvaluatorUsage.Get, EvaluatorFlags.DoNotSpecialize);

        const type = TypeUtils.doForSubtypes(baseTypeResult.type, subtype => {
            if (subtype.isAny()) {
                return subtype;
            } else if (subtype instanceof ClassType) {
                let typeArgs = this._getTypeArgs(node.items);
                return this._createSpecializeClassType(subtype, typeArgs,
                    node.items, flags);
            } else if (subtype instanceof FunctionType) {
                // TODO - need to implement
                return UnknownType.create();
            } else if (subtype instanceof ObjectType) {
                // TODO - need to implement
                return UnknownType.create();
            } else if (subtype instanceof NoneType) {
                this._addDiagnostic(
                    this._configOptions.reportOptionalSubscript,
                    `Optional of type 'None' cannot be subscripted`,
                    node.baseExpression);

                return UnknownType.create();
            } else {
                this._addError(
                    `Object of type '${ subtype.asString() }' cannot be subscripted`,
                    node.baseExpression);

                return UnknownType.create();
            }
        });

        return { type, node };
    }

    private _getTypeArgs(node: IndexItemsNode): TypeResult[] {
        let typeArgs: TypeResult[] = [];

        node.items.forEach(expr => {
            typeArgs.push(this._getTypeArg(expr));
        });

        return typeArgs;
    }

    private _getTypeArg(node: ExpressionNode): TypeResult {
        let typeResult: TypeResult;

        if (node instanceof ListNode) {
            typeResult = {
                type: UnknownType.create(),
                typeList: node.entries.map(entry => {
                    return this._getTypeFromExpression(entry,
                        EvaluatorUsage.Get, EvaluatorFlags.ConvertClassToObject);
                }),
                node
            };
        } else {
            typeResult = this._getTypeFromExpression(node,
                EvaluatorUsage.Get, EvaluatorFlags.ConvertClassToObject);
        }

        return typeResult;
    }

    private _getTypeFromTupleExpression(node: TupleExpressionNode,
            usage: EvaluatorUsage, flags: EvaluatorFlags): TypeResult {

        const entryTypes = node.expressions.map(expr => {
            return this._getTypeFromExpression(expr, usage, flags) || UnknownType.create();
        });

        let type = UnknownType.create();
        let builtInTupleType = ScopeUtils.getBuiltInType(this._scope, 'Tuple');

        if (builtInTupleType instanceof ClassType) {
            type = this._createSpecialType(builtInTupleType, entryTypes,
                EvaluatorFlags.ConvertClassToObject);
        }

        return { type, node };
    }

    private _getTypeFromCallExpression(node: CallExpressionNode,
            flags: EvaluatorFlags): TypeResult {

        const baseTypeResult = this._getTypeFromExpression(
            node.leftExpression, EvaluatorUsage.Get, EvaluatorFlags.None);

        const argList = node.arguments.map(arg => {
            return {
                valueExpression: arg.valueExpression,
                argumentCategory: arg.argumentCategory,
                name: arg.name,
                type: this._getTypeFromExpression(arg.valueExpression,
                    EvaluatorUsage.Get, EvaluatorFlags.None).type
            };
        });

        return this._getTypeFromCallExpressionWithBaseType(
            node.leftExpression, argList, baseTypeResult, flags);
    }

    private _getTypeFromCallExpressionWithBaseType(errorNode: ExpressionNode,
            argList: FunctionArgument[], baseTypeResult: TypeResult,
            flags: EvaluatorFlags): TypeResult {

        let type: Type | undefined;
        const callType = baseTypeResult.type;

        if (callType instanceof ClassType) {
            if (callType.isBuiltIn()) {
                const className = callType.getClassName();

                if (className === 'type') {
                    // Handle the 'type' call specially.
                    if (argList.length >= 1) {
                        let argType = argList[0].type;
                        if (argType instanceof ObjectType) {
                            type = argType.getClassType();
                        }
                    }

                    // If the parameter to type() is not statically known,
                    // fall back to unknown.
                    if (!type) {
                        type = UnknownType.create();
                    }
                } else if (className === 'TypeVar') {
                    type = this._createTypeVarType(errorNode, argList);
                } else if (className === 'NamedTuple') {
                    type = this._createNamedTupleType(errorNode, argList, true);
                    flags &= ~EvaluatorFlags.ConvertClassToObject;
                }
            } else if (callType.isAbstractClass()) {
                // If the class is abstract, it can't be instantiated.
                const symbolTable = new StringMap<ClassMember>();
                TypeUtils.getAbstractMethodsRecursive(callType, symbolTable);

                const diagAddendum = new DiagnosticAddendum();
                const symbolTableKeys = symbolTable.getKeys();
                const errorsToDisplay = 2;

                symbolTableKeys.forEach((symbolName, index) => {
                    if (index === errorsToDisplay) {
                        diagAddendum.addMessage(`and ${ symbolTableKeys.length - errorsToDisplay } more...`);
                    } else if (index < errorsToDisplay) {
                        const symbolWithClass = symbolTable.get(symbolName)!;

                        if (symbolWithClass.classType instanceof ClassType) {
                            const className = symbolWithClass.classType.getClassName();
                            diagAddendum.addMessage(`'${ className }.${ symbolName }' is abstract`);
                        }
                    }
                });

                this._addError(
                    `Cannot instantiate abstract class '${ callType.getClassName() }'` +
                        diagAddendum.getString(),
                    errorNode);
            }

            // Assume this is a call to the constructor.
            if (!type) {
                type = this._validateConstructorArguments(errorNode, argList, callType);
            }
        } else if (callType instanceof FunctionType) {
            // The stdlib collections/__init__.pyi stub file defines namedtuple
            // as a function rather than a class, so we need to check for it here.
            if (callType.getBuiltInName() === 'namedtuple') {
                type = this._createNamedTupleType(errorNode, argList, false);
                flags &= ~EvaluatorFlags.ConvertClassToObject;
            } else {
                type = this._validateCallArguments(errorNode, argList, callType, new TypeVarMap());
                if (!type) {
                    type = UnknownType.create();
                }
            }
        } else if (callType instanceof OverloadedFunctionType) {
            // Determine which of the overloads (if any) match.
            let functionType = this._findOverloadedFunctionType(errorNode, argList, callType);

            if (functionType) {
                type = this._validateCallArguments(errorNode, argList, callType, new TypeVarMap());
                if (!type) {
                    type = UnknownType.create();
                }
            } else {
                const exprString = ParseTreeUtils.printExpression(errorNode);
                this._addError(
                    `No overloads for '${ exprString }' match parameters`,
                    errorNode);
                type = UnknownType.create();
            }
        } else if (callType instanceof ObjectType) {
            const classType = callType.getClassType();

            // Handle the "Type" object specially.
            if (classType.isBuiltIn() && classType.getClassName() === 'Type') {
                const typeArgs = classType.getTypeArguments();
                if (typeArgs && typeArgs.length >= 1 && typeArgs[0] instanceof ObjectType) {
                    const objType = typeArgs[0] as ObjectType;
                    type = this._validateConstructorArguments(errorNode,
                        argList, objType.getClassType());
                }
            } else {
                let memberType = this._getTypeFromClassMemberName(
                    classType, '__call__', EvaluatorUsage.Get,
                    MemberAccessFlags.SkipForMethodLookup);
                if (memberType && memberType instanceof FunctionType) {
                    const callMethodType = TypeUtils.bindFunctionToClassOrObject(callType, memberType);
                    type = this._validateCallArguments(errorNode, argList, callMethodType, new TypeVarMap());
                    if (!type) {
                        type = UnknownType.create();
                    }
                }
            }
        } else if (callType instanceof UnionType) {
            let returnTypes: Type[] = [];
            callType.getTypes().forEach(typeEntry => {
                if (typeEntry instanceof NoneType) {
                    this._addDiagnostic(
                        this._configOptions.reportOptionalCall,
                        `Object of type 'None' cannot be called`,
                        errorNode);
                } else {
                    let typeResult = this._getTypeFromCallExpressionWithBaseType(
                        errorNode,
                        argList,
                        {
                            type: typeEntry,
                            node: baseTypeResult.node
                        },
                        EvaluatorFlags.None);
                    if (typeResult) {
                        returnTypes.push(typeResult.type);
                    }
                }
            });

            if (returnTypes.length > 0) {
                type = TypeUtils.combineTypes(returnTypes);
            }
        } else if (callType.isAny()) {
            type = UnknownType.create();
        }

        if (!type) {
            this._addError(
                `'${ ParseTreeUtils.printExpression(errorNode) }' has type ` +
                `'${ callType.asString() }' and is not callable`,
                errorNode);
            type = UnknownType.create();
        }

        // Should we specialize the class?
        if ((flags & EvaluatorFlags.DoNotSpecialize) === 0) {
            if (type instanceof ClassType) {
                type = this._createSpecializeClassType(type, undefined, errorNode, flags);
            }
        }

        type = this._convertClassToObjectConditional(type, flags);

        return { type, node: baseTypeResult.node };
    }

    private _findOverloadedFunctionType(errorNode: ExpressionNode, argList: FunctionArgument[],
            callType: OverloadedFunctionType): FunctionType | undefined {

        let validOverload: FunctionType | undefined;

        // Temporarily disable diagnostic output.
        this._silenceDiagnostics(() => {
            for (let overload of callType.getOverloads()) {
                if (this._validateCallArguments(errorNode, argList, overload.type, new TypeVarMap())) {
                    validOverload = overload.type;
                    break;
                }
            }
        });

        return validOverload;
    }

    // Tries to match the arguments of a call to the constructor for a class.
    // If successful, it returns the resulting (specialized) object type that
    // is allocated by the constructor. If unsuccessful, it records diagnostic
    // information and returns undefined.
    private _validateConstructorArguments(errorNode: ExpressionNode,
            argList: FunctionArgument[], type: ClassType): Type | undefined {
        let validatedTypes = false;
        let returnType: Type | undefined;
        let reportedErrorsForNewCall = false;

        // Validate __new__
        let constructorMethodType = this._getTypeFromClassMemberName(type, '__new__',
            EvaluatorUsage.Get, MemberAccessFlags.SkipForMethodLookup |
                MemberAccessFlags.SkipObjectBaseClass);
        if (constructorMethodType) {
            constructorMethodType = TypeUtils.bindFunctionToClassOrObject(
                type, constructorMethodType, true);
            returnType = this._validateCallArguments(errorNode, argList, constructorMethodType,
                new TypeVarMap());
            if (!returnType) {
                reportedErrorsForNewCall = true;
            }
            validatedTypes = true;
        }

        // Validate __init__
        // Don't report errors for __init__ if __new__ already generated errors. They're
        // probably going to be entirely redundant anyway.
        if (!reportedErrorsForNewCall) {
            let initMethodType = this._getTypeFromClassMemberName(type, '__init__',
                EvaluatorUsage.Get, MemberAccessFlags.SkipForMethodLookup |
                    MemberAccessFlags.SkipObjectBaseClass);
            if (initMethodType) {
                initMethodType = TypeUtils.bindFunctionToClassOrObject(
                    new ObjectType(type), initMethodType);
                let typeVarMap = new TypeVarMap();
                if (this._validateCallArguments(errorNode, argList, initMethodType, typeVarMap)) {
                    let specializedClassType = type;
                    if (!typeVarMap.isEmpty()) {
                        specializedClassType = TypeUtils.specializeType(type, typeVarMap) as ClassType;
                        assert(specializedClassType instanceof ClassType);
                    }
                    returnType = new ObjectType(specializedClassType);
                }
                validatedTypes = true;
            }
        }

        if (!validatedTypes && argList.length > 0) {
            this._addError(
                `Expected no arguments to '${ type.getClassName() }' constructor`, errorNode);
        } else if (!returnType) {
            // There was no __new__ or __init__, so fall back on the
            // object.__new__ which takes no parameters.
            returnType = new ObjectType(type);
        }

        // Make the type concrete if it wasn't already specialized.
        if (returnType) {
            returnType = TypeUtils.specializeType(returnType, undefined);
        }

        return returnType;
    }

    // Validates that the arguments can be assigned to the call's parameter
    // list, specializes the call based on arg types, and returns the
    // specialized type of the return value. If it detects an error along
    // the way, it emits a diagnostic and returns undefined.
    private _validateCallArguments(errorNode: ExpressionNode,
            argList: FunctionArgument[], callType: Type, typeVarMap: TypeVarMap): Type | undefined {

        let returnType: Type | undefined;

        if (callType.isAny()) {
            returnType = UnknownType.create();
        } else if (callType instanceof FunctionType) {
            returnType = this._validateFunctionArguments(errorNode, argList, callType, typeVarMap);
        } else if (callType instanceof OverloadedFunctionType) {
            const overloadedFunctionType = this._findOverloadedFunctionType(
                errorNode, argList, callType);
            if (overloadedFunctionType) {
                returnType = this._validateFunctionArguments(errorNode,
                    argList, overloadedFunctionType, typeVarMap);
            }
        } else if (callType instanceof ClassType) {
            if (!callType.isSpecialBuiltIn()) {
                returnType = this._validateConstructorArguments(errorNode, argList, callType);
            } else {
                this._addError(
                    `'${ callType.getClassName() }' cannot be instantiated`,
                    errorNode);
            }
        } else if (callType instanceof ObjectType) {
            let memberType = this._getTypeFromClassMemberName(
                callType.getClassType(), '__call__', EvaluatorUsage.Get,
                    MemberAccessFlags.SkipForMethodLookup);

            if (memberType && memberType instanceof FunctionType) {
                const callMethodType = TypeUtils.stripFirstParameter(memberType);
                returnType = this._validateCallArguments(
                    errorNode, argList, callMethodType, typeVarMap);
            }
        } else if (callType instanceof UnionType) {
            let returnTypes: Type[] = [];

            for (let type of callType.getTypes()) {
                if (type instanceof NoneType) {
                    this._addDiagnostic(
                        this._configOptions.reportOptionalCall,
                        `Object of type 'None' cannot be called`,
                        errorNode);
                } else {
                    let entryReturnType = this._validateCallArguments(
                        errorNode, argList, type, typeVarMap);
                    if (entryReturnType) {
                        returnTypes.push(entryReturnType);
                    }
                }
            }

            if (returnTypes.length > 0) {
                returnType = TypeUtils.combineTypes(returnTypes);
            }
        }

        // Make the type concrete if it wasn't already specialized.
        if (returnType) {
            returnType = TypeUtils.specializeType(returnType, undefined);
        }

        return returnType;
    }

    // Tries to assign the call arguments to the function parameter
    // list and reports any mismatches in types or counts. Returns the
    // specialized return type of the call.
    // This logic is based on PEP 3102: https://www.python.org/dev/peps/pep-3102/
    private _validateFunctionArguments(errorNode: ExpressionNode,
            argList: FunctionArgument[], type: FunctionType, typeVarMap: TypeVarMap): Type | undefined {

        let argIndex = 0;
        const typeParams = type.getParameters();

        // The last parameter might be a var arg dictionary. If so, strip it off.
        let hasVarArgDictParam = typeParams.find(
                param => param.category === ParameterCategory.VarArgDictionary) !== undefined;
        let reportedArgError = false;

        // Build a map of parameters by name.
        let paramMap = new StringMap<ParamAssignmentInfo>();
        typeParams.forEach(param => {
            if (param.name) {
                paramMap.set(param.name, {
                    argsNeeded: param.category === ParameterCategory.Simple && !param.hasDefault ? 1 : 0,
                    argsReceived: 0
                });
            }
        });

        // Is there a bare (nameless) "*" parameter? If so, it signifies the end
        // of the positional parameter list.
        let positionalParamCount = typeParams.findIndex(
            param => param.category === ParameterCategory.VarArgList && !param.name);

        // Is there a var-arg (named "*") parameter? If so, it is the last of
        // the positional parameters.
        if (positionalParamCount < 0) {
            positionalParamCount = typeParams.findIndex(
                param => param.category === ParameterCategory.VarArgList);
            if (positionalParamCount >= 0) {
                positionalParamCount++;
            }
        }

        // Is there a keyword var-arg ("**") parameter? If so, it's not included
        // in the list of positional parameters.
        if (positionalParamCount < 0) {
            positionalParamCount = typeParams.findIndex(
                param => param.category === ParameterCategory.VarArgDictionary);
        }

        // If we didn't see any special cases, then all parameters are positional.
        if (positionalParamCount < 0) {
            positionalParamCount = typeParams.length;
        }

        // Determine how many positional args are being passed before
        // we see a named arg.
        let positionalArgCount = argList.findIndex(
            arg => arg.argumentCategory === ArgumentCategory.Dictionary || arg.name !== undefined);
        if (positionalArgCount < 0) {
            positionalArgCount = argList.length;
        }

        // Map the positional args to parameters.
        let paramIndex = 0;
        while (argIndex < positionalArgCount) {
            if (paramIndex >= positionalParamCount) {
                let adjustedCount = positionalParamCount;
                this._addError(
                    `Expected ${ adjustedCount } positional ` +
                    `${ adjustedCount === 1 ? 'argument' : 'arguments' }`,
                    argList[argIndex].valueExpression || errorNode);
                reportedArgError = true;
                break;
            }

            if (typeParams[paramIndex].category === ParameterCategory.VarArgList) {
                // Consume the remaining positional args.
                argIndex = positionalArgCount;
            } else {
                let paramType = type.getEffectiveParameterType(paramIndex);
                if (!this._validateArgType(paramType, argList[argIndex].type,
                        argList[argIndex].valueExpression || errorNode, typeVarMap)) {
                    reportedArgError = true;
                }

                // Note that the parameter has received an argument.
                const paramName = typeParams[paramIndex].name;
                if (paramName) {
                    paramMap.get(paramName)!.argsReceived++;
                }

                argIndex++;
            }

            paramIndex++;
        }

        if (!reportedArgError) {
            let foundDictionaryArg = false;
            let foundListArg = argList.find(
                arg => arg.argumentCategory === ArgumentCategory.List) !== undefined;

            // Now consume any named parameters.
            while (argIndex < argList.length) {
                if (argList[argIndex].argumentCategory === ArgumentCategory.Dictionary) {
                    foundDictionaryArg = true;
                } else {
                    // Protect against the case where a non-named argument appears after
                    // a named argument. This will have already been reported as a parse
                    // error, but we need to protect against it here.
                    const paramName = argList[argIndex].name;
                    if (paramName) {
                        const paramNameValue = paramName.nameToken.value;
                        const paramEntry = paramMap.get(paramNameValue);
                        if (paramEntry) {
                            if (paramEntry.argsReceived > 0) {
                                this._addError(
                                    `Parameter '${ paramNameValue }' is already assigned`, paramName);
                                reportedArgError = true;
                            } else {
                                paramMap.get(paramName.nameToken.value)!.argsReceived++;

                                let paramInfoIndex = typeParams.findIndex(
                                    param => param.name === paramNameValue);
                                assert(paramInfoIndex >= 0);
                                const paramType = type.getEffectiveParameterType(paramInfoIndex);
                                if (!this._validateArgType(paramType, argList[argIndex].type,
                                        argList[argIndex].valueExpression || errorNode, typeVarMap)) {
                                    reportedArgError = true;
                                }
                            }
                        } else if (!hasVarArgDictParam) {
                            this._addError(
                                `No parameter named '${ paramName.nameToken.value }'`, paramName);
                            reportedArgError = true;
                        }
                    }
                }

                argIndex++;
            }

            // Determine whether there are any parameters that require arguments
            // but have not yet received them. If we received a dictionary argument
            // (i.e. an arg starting with a "**") or a list argument (i.e. an arg
            // starting with a "*"), we will assume that all parameters are matched.
            if (!foundDictionaryArg && !foundListArg) {
                let unassignedParams = paramMap.getKeys().filter(name => {
                    const entry = paramMap.get(name)!;
                    return entry.argsReceived < entry.argsNeeded;
                });

                if (unassignedParams.length > 0) {
                    this._addError(
                        `Argument missing for parameter${ unassignedParams.length === 1 ? '' : 's' } ` +
                        unassignedParams.map(p => `'${ p }'`).join(', '), errorNode);
                    reportedArgError = true;
                }
            }
        }

        if (reportedArgError) {
            return undefined;
        }

        return TypeUtils.specializeType(type.getEffectiveReturnType(), typeVarMap);
    }

    private _validateArgType(paramType: Type, argType: Type, errorNode: ExpressionNode,
            typeVarMap: TypeVarMap): boolean {

        const diag = new DiagnosticAddendum();
        if (!TypeUtils.canAssignType(paramType, argType, diag.createAddendum(), typeVarMap)) {
            this._addError(
                `Argument of type '${ argType.asString() }'` +
                    ` cannot be assigned to parameter of type '${ paramType.asString() }'` +
                    diag.getString(),
                errorNode);
            return false;
        }

        return true;
    }

    private _createTypeVarType(errorNode: ExpressionNode, argList: FunctionArgument[]): Type | undefined {
        let typeVarName = '';
        if (argList.length === 0) {
            this._addError('Expected name of type var', errorNode);
            return undefined;
        }

        let firstArg = argList[0];
        if (firstArg.valueExpression instanceof StringNode) {
            typeVarName = firstArg.valueExpression.getValue();
        } else {
            this._addError('Expected name of type var as first parameter',
                firstArg.valueExpression || errorNode);
        }

        let typeVar = new TypeVarType(typeVarName);

        // Parse the remaining parameters.
        for (let i = 1; i < argList.length; i++) {
            const paramNameNode = argList[i].name;
            const paramName = paramNameNode ? paramNameNode.nameToken.value : undefined;
            let paramNameMap = new StringMap<string>();

            if (paramName) {
                if (paramNameMap.get(paramName)) {
                    this._addError(
                        `Duplicate parameter name '${ paramName }' not allowed`,
                        argList[i].valueExpression || errorNode);
                }

                if (paramName === 'bound') {
                    if (typeVar.getConstraints().length > 0) {
                        this._addError(
                            `A TypeVar cannot be bounded and constrained`,
                            argList[i].valueExpression || errorNode);
                    } else {
                        typeVar.setBoundType(this._convertClassToObject(argList[i].type));
                    }
                } else if (paramName === 'covariant') {
                    if (argList[i].valueExpression && this._getBooleanValue(argList[i].valueExpression!)) {
                        if (typeVar.isContravariant()) {
                            this._addError(
                                `A TypeVar cannot be both covariant and contravariant`,
                                argList[i].valueExpression!);
                        } else {
                            typeVar.setIsCovariant();
                        }
                    }
                } else if (paramName === 'contravariant') {
                    if (argList[i].valueExpression && this._getBooleanValue(argList[i].valueExpression!)) {
                        if (typeVar.isContravariant()) {
                            this._addError(
                                `A TypeVar cannot be both covariant and contravariant`,
                                argList[i].valueExpression!);
                        } else {
                            typeVar.setIsContravariant();
                        }
                    }
                } else {
                    this._addError(
                        `'${ paramName }' is unknown parameter to TypeVar`,
                        argList[i].valueExpression || errorNode);
                }

                paramNameMap.set(paramName, paramName);
            } else {
                if (typeVar.getBoundType()) {
                    this._addError(
                        `A TypeVar cannot be bounded and constrained`,
                        argList[i].valueExpression || errorNode);
                } else {
                    typeVar.addConstraint(this._convertClassToObject(argList[i].type));
                }
            }
        }

        return typeVar;
    }

    private _getBooleanValue(node: ExpressionNode): boolean {
        if (node instanceof ConstantNode) {
            if (node.token instanceof KeywordToken) {
                if (node.token.keywordType === KeywordType.False) {
                    return false;
                } else if (node.token.keywordType === KeywordType.True) {
                    return true;
                }
            }
        }

        this._addError('Expected True or False', node);
        return false;
    }

    // Creates a new custom tuple factory class with named values.
    // Supports both typed and untyped variants.
    private _createNamedTupleType(errorNode: ExpressionNode, argList: FunctionArgument[],
            includesTypes: boolean): ClassType {

        let className = 'namedtuple';
        if (argList.length === 0) {
            this._addError('Expected named tuple class name as first parameter',
                errorNode);
        } else {
            const nameArg = argList[0];
            if (nameArg.argumentCategory !== ArgumentCategory.Simple) {
                this._addError('Expected named tuple class name as first parameter',
                    argList[0].valueExpression || errorNode);
            } else if (nameArg.valueExpression instanceof StringNode) {
                className = nameArg.valueExpression.getValue();
            }
        }

        let classType = new ClassType(className, ClassTypeFlags.None,
            AnalyzerNodeInfo.getTypeSourceId(errorNode));
        classType.addBaseClass(ScopeUtils.getBuiltInType(this._scope, 'NamedTuple'), false);
        const classFields = classType.getClassFields();
        classFields.set('__class__', new Symbol(classType, DefaultTypeSourceId));
        const instanceFields = classType.getInstanceFields();

        let builtInTupleType = ScopeUtils.getBuiltInType(this._scope, 'Tuple');
        if (builtInTupleType instanceof ClassType) {
            let constructorType = new FunctionType(FunctionTypeFlags.StaticMethod);
            constructorType.setDeclaredReturnType(new ObjectType(classType));
            constructorType.addParameter({
                category: ParameterCategory.Simple,
                name: 'cls',
                type: classType
            });

            let initType = new FunctionType(FunctionTypeFlags.InstanceMethod);
            const selfParameter: FunctionParameter = {
                category: ParameterCategory.Simple,
                name: 'self',
                type: new ObjectType(classType)
            };
            initType.setDeclaredReturnType(NoneType.create());
            initType.addParameter(selfParameter);

            let addGenericGetAttribute = false;

            if (argList.length < 2) {
                this._addError('Expected named tuple entry list as second parameter',
                    errorNode);
                addGenericGetAttribute = true;
            } else {
                const entriesArg = argList[1];
                if (entriesArg.argumentCategory !== ArgumentCategory.Simple) {
                    addGenericGetAttribute = true;
                } else {
                    if (!includesTypes && entriesArg.valueExpression instanceof StringNode) {
                        let entries = entriesArg.valueExpression.getValue().split(' ');
                        entries.forEach(entryName => {
                            entryName = entryName.trim();
                            if (entryName) {
                                let entryType = UnknownType.create();
                                const paramInfo: FunctionParameter = {
                                    category: ParameterCategory.Simple,
                                    name: entryName,
                                    type: entryType
                                };

                                constructorType.addParameter(paramInfo);
                                initType.addParameter(paramInfo);

                                instanceFields.set(entryName, new Symbol(entryType, DefaultTypeSourceId));
                            }
                        });
                    } else if (entriesArg.valueExpression instanceof ListNode) {
                        const entryList = entriesArg.valueExpression;
                        let entryMap: { [name: string]: string } = {};

                        entryList.entries.forEach((entry, index) => {
                            let entryType: Type | undefined;
                            let entryNameNode: ExpressionNode | undefined;
                            let entryName = '';

                            if (includesTypes) {
                                // Handle the variant that includes name/type tuples.
                                if (entry instanceof TupleExpressionNode && entry.expressions.length === 2) {
                                    entryNameNode = entry.expressions[0];
                                    let entryTypeInfo = this._getTypeFromExpression(entry.expressions[1],
                                        EvaluatorUsage.Get, EvaluatorFlags.None);
                                    if (entryTypeInfo) {
                                        entryType = this._convertClassToObject(entryTypeInfo.type);
                                    }
                                } else {
                                    this._addError(
                                        'Expected two-entry tuple specifying entry name and type', entry);
                                }
                            } else {
                                entryNameNode = entry;
                                entryType = UnknownType.create();
                            }

                            if (entryNameNode instanceof StringNode) {
                                entryName = entryNameNode.getValue();
                                if (!entryName) {
                                    this._addError(
                                        'Names within a named tuple cannot be empty', entryNameNode);
                                }
                            } else {
                                this._addError(
                                    'Expected string literal for entry name', entryNameNode || entry);
                            }

                            if (!entryName) {
                                entryName = `_${ index.toString() }`;
                            }

                            if (entryMap[entryName]) {
                                this._addError(
                                    'Names within a named tuple must be unique', entryNameNode || entry);
                            }

                            // Record names in a map to detect duplicates.
                            entryMap[entryName] = entryName;

                            if (!entryType) {
                                entryType = UnknownType.create();
                            }

                            const paramInfo: FunctionParameter = {
                                category: ParameterCategory.Simple,
                                name: entryName,
                                type: entryType
                            };

                            constructorType.addParameter(paramInfo);
                            initType.addParameter(paramInfo);

                            instanceFields.set(entryName, new Symbol(entryType, DefaultTypeSourceId));
                        });
                    } else {
                        // A dynamic expression was used, so we can't evaluate
                        // the named tuple statically.
                        addGenericGetAttribute = true;
                    }
                }
            }

            if (addGenericGetAttribute) {
                TypeUtils.addDefaultFunctionParameters(constructorType);
                TypeUtils.addDefaultFunctionParameters(initType);
            }

            classFields.set('__new__', new Symbol(constructorType, DefaultTypeSourceId));
            classFields.set('__init__', new Symbol(initType, DefaultTypeSourceId));

            let keysItemType = new FunctionType(FunctionTypeFlags.None);
            keysItemType.setDeclaredReturnType(ScopeUtils.getBuiltInObject(this._scope, 'list',
                [ScopeUtils.getBuiltInObject(this._scope, 'str')]));
            classFields.set('keys', new Symbol(keysItemType, DefaultTypeSourceId));
            classFields.set('items', new Symbol(keysItemType, DefaultTypeSourceId));

            let lenType = new FunctionType(FunctionTypeFlags.InstanceMethod);
            lenType.setDeclaredReturnType(ScopeUtils.getBuiltInObject(this._scope, 'int'));
            lenType.addParameter(selfParameter);
            classFields.set('__len__', new Symbol(lenType, DefaultTypeSourceId));

            if (addGenericGetAttribute) {
                let getAttribType = new FunctionType(FunctionTypeFlags.InstanceMethod);
                getAttribType.setDeclaredReturnType(AnyType.create());
                getAttribType.addParameter(selfParameter);
                getAttribType.addParameter({
                    category: ParameterCategory.Simple,
                    name: 'name',
                    type: ScopeUtils.getBuiltInObject(this._scope, 'str')
                });
                classFields.set('__getattribute__', new Symbol(getAttribType, DefaultTypeSourceId));
            }
        }

        return classType;
    }

    private _reportUsageErrorForReadOnly(node: ParseNode, usage: EvaluatorUsage) {
        if (usage === EvaluatorUsage.Set) {
            this._addError(`Constant value cannot be assigned`, node);
        } else if (usage === EvaluatorUsage.Delete) {
            this._addError(`Constant value cannot be deleted`, node);
        }
    }

    private _getTypeFromConstantExpression(node: ConstantNode): TypeResult | undefined {
        let type: Type | undefined;

        if (node.token.type === TokenType.Keyword) {
            if (node.token.keywordType === KeywordType.None) {
                type = NoneType.create();
            } else if (node.token.keywordType === KeywordType.True ||
                    node.token.keywordType === KeywordType.False ||
                    node.token.keywordType === KeywordType.Debug) {
                type = ScopeUtils.getBuiltInObject(this._scope, 'bool');

                // For True and False, we can create truthy and falsy
                // versions of 'bool'.
                if (type instanceof ObjectType) {
                    if (node.token.keywordType === KeywordType.True) {
                        type = type.cloneAsTruthy();
                    } else if (node.token.keywordType === KeywordType.False) {
                        type = type.cloneAsFalsy();
                    }
                }
            }
        }

        if (!type) {
            return undefined;
        }

        return { type, node };
    }

    private _getTypeFromUnaryExpression(node: UnaryExpressionNode,
            flags: EvaluatorFlags): TypeResult {

        let exprType = this._getTypeFromExpression(node.expression,
            EvaluatorUsage.Get, flags).type;

        // Map unary operators to magic functions. Note that the bitwise
        // invert has two magic functions that are aliases of each other.
        const unaryOperatorMap: { [operator: number]: string } = {
            [OperatorType.Add]: '__pos__',
            [OperatorType.Subtract]: '__neg__',
            [OperatorType.Not]: '__not__',
            [OperatorType.BitwiseInvert]: '__inv__'
        };

        let type: Type | undefined;

        // __not__ always returns a boolean.
        if (node.operator === OperatorType.Not) {
            type = ScopeUtils.getBuiltInObject(this._scope, 'bool');
        } else {
            if (exprType.isAny()) {
                type = exprType;
            } else {
                const magicMethodName = unaryOperatorMap[node.operator];
                type = this._getTypeFromMagicMethodReturn(exprType, magicMethodName);
            }

            if (!type) {
                this._addError(`Operator '${ ParseTreeUtils.printOperator(node.operator) }'` +
                    ` not supported for type '${ exprType.asString() }'`,
                    node.expression);
                type = UnknownType.create();
            }
        }

        return { type, node };
    }

    private _getTypeFromBinaryExpression(node: BinaryExpressionNode,
            flags: EvaluatorFlags): TypeResult {

        let leftType = this._getTypeFromExpression(node.leftExpression,
            EvaluatorUsage.Get, flags).type;
        let rightType = this._getTypeFromExpression(node.rightExpression,
            EvaluatorUsage.Get, flags).type;

        // Is this an AND operator? If so, we can assume that the
        // rightExpression won't be evaluated at runtime unless the
        // leftExpression evaluates to true.
        let typeConstraints: ConditionalTypeConstraintResults | undefined;
        if (node.operator === OperatorType.And) {
            typeConstraints = this._buildTypeConstraints(node.leftExpression);
        }

        this._useExpressionTypeConstraint(typeConstraints, true, () => {
            this._getTypeFromExpression(node.rightExpression, EvaluatorUsage.Get, flags);
        });

        const arithmeticOperatorMap: { [operator: number]: [string, string, boolean] } = {
            [OperatorType.Add]: ['__add__', '__radd__', true],
            [OperatorType.Subtract]: ['__sub__', '__rsub__', true],
            [OperatorType.Multiply]: ['__mul__', '__rmul__', true],
            [OperatorType.FloorDivide]: ['__floordiv__', '__rfloordiv__', true],
            [OperatorType.Divide]: ['__truediv__', '__rtruediv__', true],
            [OperatorType.Mod]: ['__mod__', '__rmod__', true],
            [OperatorType.Power]: ['__power__', '__rpower__', true],
            [OperatorType.MatrixMultiply]: ['__matmul__', '', false]
        };

        const bitwiseOperatorMap: { [operator: number]: [string, string] } = {
            [OperatorType.BitwiseAnd]: ['__and__', '__rand__'],
            [OperatorType.BitwiseOr]: ['__or__', '__ror__'],
            [OperatorType.BitwiseXor]: ['__xor__', '__rxor__'],
            [OperatorType.LeftShift]: ['__lshift__', '__rlshift__'],
            [OperatorType.RightShift]: ['__rshift__', '__rrshift__']
        };

        const comparisonOperatorMap: { [operator: number]: string } = {
            [OperatorType.Equals]: '__eq__',
            [OperatorType.NotEquals]: '__ne__',
            [OperatorType.LessThan]: '__lt__',
            [OperatorType.LessThanOrEqual]: '__le__',
            [OperatorType.GreaterThan]: '__gt__',
            [OperatorType.GreaterThanOrEqual]: '__ge__'
        };

        const booleanOperatorMap: { [operator: number]: boolean } = {
            [OperatorType.And]: true,
            [OperatorType.Or]: true,
            [OperatorType.Is]: true,
            [OperatorType.IsNot]: true,
            [OperatorType.In]: true,
            [OperatorType.NotIn]: true
        };

        let type: Type | undefined;

        if (arithmeticOperatorMap[node.operator]) {
            const supportsBuiltInTypes = arithmeticOperatorMap[node.operator][2];

            if (supportsBuiltInTypes) {
                if (leftType instanceof ObjectType && rightType instanceof ObjectType) {
                    const builtInClassTypes = this._getBuiltInClassTypes(['int', 'float', 'complex']);
                    const getTypeMatch = (classType: ClassType): boolean[] => {
                        let foundMatch = false;
                        return builtInClassTypes.map(builtInType => {
                            if (builtInType && builtInType.isSameGenericClass(classType)) {
                                foundMatch = true;
                            }
                            return foundMatch;
                        });
                    };

                    const leftClassMatches = getTypeMatch(leftType.getClassType());
                    const rightClassMatches = getTypeMatch(rightType.getClassType());

                    if (leftClassMatches[0] && rightClassMatches[0]) {
                        // If they're both int types, the result is an int.
                        type = new ObjectType(builtInClassTypes[0]!);
                    } else if (leftClassMatches[1] && rightClassMatches[1]) {
                        // If they're both floats or one is a float and one is an int,
                        // the result is a float.
                        type = new ObjectType(builtInClassTypes[1]!);
                    } else if (leftClassMatches[2] && rightClassMatches[2]) {
                        // If one is complex and the other is complex, float or int,
                        // the result is complex.
                        type = new ObjectType(builtInClassTypes[2]!);
                    }
                }
            }

            // Handle the general case.
            if (!type) {
                const magicMethodName = arithmeticOperatorMap[node.operator][0];
                type = this._getTypeFromMagicMethodReturn(leftType, magicMethodName);
            }
        } else if (bitwiseOperatorMap[node.operator]) {
            if (leftType.isAny() || rightType.isAny()) {
                type = UnknownType.create();
            } else if (leftType instanceof ObjectType && rightType instanceof ObjectType) {
                const intType = ScopeUtils.getBuiltInType(this._scope, 'int');
                const leftIsInt = intType instanceof ClassType &&
                    leftType.getClassType().isSameGenericClass(intType);
                const rightIsInt = intType instanceof ClassType &&
                    rightType.getClassType().isSameGenericClass(intType);

                if (leftIsInt && rightIsInt) {
                    type = new ObjectType(intType as ClassType);
                }
            }

            // Handle the general case.
            if (!type) {
                const magicMethodName = bitwiseOperatorMap[node.operator][0];
                type = this._getTypeFromMagicMethodReturn(leftType, magicMethodName);
            }
        } else if (comparisonOperatorMap[node.operator]) {
            const magicMethodName = comparisonOperatorMap[node.operator];

            type = this._getTypeFromMagicMethodReturn(leftType, magicMethodName,
                ScopeUtils.getBuiltInObject(this._scope, 'bool'));

        } else if (booleanOperatorMap[node.operator]) {
            if (node.operator === OperatorType.And) {
                // If the operator is an AND or OR, we need to combine the two types.
                type = TypeUtils.combineTypes([
                    TypeUtils.removeTruthinessFromType(leftType), rightType]);
            } else if (node.operator === OperatorType.Or) {
                type = TypeUtils.combineTypes([
                    TypeUtils.removeFalsinessFromType(leftType), rightType]);
            } else {
                // The other boolean operators always return a bool value.
                type = ScopeUtils.getBuiltInObject(this._scope, 'bool');
            }
        }

        if (!type) {
            this._addError(`Operator '${ ParseTreeUtils.printOperator(node.operator) }' not ` +
                `supported for type '${ leftType.asString() }'`,
                node.leftExpression);
            type = UnknownType.create();
        }

        return { type, node };
    }

    private _getTypeFromMagicMethodReturn(objType: Type, magicMethodName: string,
            fallbackType: Type | undefined = UnknownType.create()): Type | undefined {

        return TypeUtils.doForSubtypes(objType, subtype => {
            if (subtype.isAny()) {
                return UnknownType.create();
            }

            if (subtype instanceof ObjectType) {
                let magicMethodType = this._getTypeFromClassMemberName(subtype.getClassType(),
                    magicMethodName, EvaluatorUsage.Get, MemberAccessFlags.SkipForMethodLookup);
                if (magicMethodType && magicMethodType instanceof FunctionType) {
                    return magicMethodType.getEffectiveReturnType();
                }
            }

            return fallbackType;
        });
    }

    private _getBuiltInClassTypes(names: string[]): (ClassType | undefined)[] {
        return names.map(name => {
            let classType = ScopeUtils.getBuiltInType(this._scope, name);
            return classType instanceof ClassType ? classType : undefined;
        });
    }

    private _getBuiltInTypeFromLiteralExpression(node: ExpressionNode,
            typeName: string): TypeResult | undefined {

        let type = ScopeUtils.getBuiltInObject(this._scope, typeName);

        if (!type) {
            return undefined;
        }

        return { type, node };
    }

    private _getTypeFromSetExpression(node: SetNode): TypeResult {
        const entryTypes = node.entries.map(expr =>
            this._getTypeFromExpression(expr, EvaluatorUsage.Get, EvaluatorFlags.None)
        );

        // Infer the set type based on the entries.
        const inferredEntryType = entryTypes.length > 0 ?
            TypeUtils.combineTypes(entryTypes.map(e => e.type)) :
            UnknownType.create();

        let type = ScopeUtils.getBuiltInObject(this._scope, 'set', [inferredEntryType]);

        return { type, node };
    }

    private _getTypeFromDictionaryExpression(node: DictionaryNode): TypeResult {
        let keyType = UnknownType.create();
        let valueType = UnknownType.create();

        // TODO - infer key and value types
        const type = ScopeUtils.getBuiltInObject(this._scope, 'dict', [keyType, valueType]);

        return { type, node };
    }

    private _getTypeFromListExpression(node: ListNode, usage: EvaluatorUsage): TypeResult {
        let listTypes: TypeResult[] = [];
        node.entries.forEach(expr => {
            listTypes.push(this._getTypeFromExpression(expr,
                usage, EvaluatorFlags.None));
        });

        let type = ScopeUtils.getBuiltInType(this._scope, 'list');

        let convertedType: Type;
        if (type instanceof ClassType) {
            const entryTypes = node.entries.map(entry => this._getTypeFromExpression(
                entry, EvaluatorUsage.Get, EvaluatorFlags.None));

            const listEntryType = entryTypes.length > 0 ?
                TypeUtils.combineTypes(entryTypes.map(e => e.type)) :
                UnknownType.create();

            type = type.cloneForSpecialization([listEntryType]);

            // List literals are always objects, not classes.
            convertedType = this._convertClassToObject(type);
        } else {
            convertedType = UnknownType.create();
        }

        return { type: convertedType, node };
    }

    private _getTypeFromTernaryExpression(node: TernaryExpressionNode, flags: EvaluatorFlags): TypeResult {
        this._getTypeFromExpression(node.testExpression,
            EvaluatorUsage.Get, EvaluatorFlags.None);

        // Apply the type constraint when evaluating the if and else clauses.
        let typeConstraints = this._buildTypeConstraints(node.testExpression);

        let ifType: TypeResult | undefined;
        this._useExpressionTypeConstraint(typeConstraints, true, () => {
            ifType = this._getTypeFromExpression(node.ifExpression,
                EvaluatorUsage.Get, flags);
        });

        let elseType: TypeResult | undefined;
        this._useExpressionTypeConstraint(typeConstraints, false, () => {
            elseType = this._getTypeFromExpression(node.elseExpression,
                EvaluatorUsage.Get, flags);
        });

        let type = TypeUtils.combineTypes([ifType!.type, elseType!.type]);
        return { type, node };
    }

    private _getTypeFromYieldExpression(node: YieldExpressionNode): TypeResult {
        let sentType: Type | undefined;

        const enclosingFunction = ParseTreeUtils.getEnclosingFunction(node);
        if (enclosingFunction) {
            const functionType = AnalyzerNodeInfo.getExpressionType(enclosingFunction)! as FunctionType;
            assert(functionType instanceof FunctionType);
            sentType = TypeUtils.getDeclaredGeneratorSendType(functionType);
        }

        if (!sentType) {
            sentType = UnknownType.create();
        }

        return { type: sentType, node };
    }

    private _getTypeFromYieldFromExpression(node: YieldFromExpressionNode): TypeResult {
        let sentType: Type | undefined;

        const enclosingFunction = ParseTreeUtils.getEnclosingFunction(node);
        if (enclosingFunction) {
            const functionType = AnalyzerNodeInfo.getExpressionType(enclosingFunction)! as FunctionType;
            assert(functionType instanceof FunctionType);
            sentType = TypeUtils.getDeclaredGeneratorSendType(functionType);
        }

        if (!sentType) {
            sentType = UnknownType.create();
        }

        return { type: sentType, node };
    }

    private _getTypeFromLambdaExpression(node: LambdaNode): TypeResult {
        // The lambda node is updated by typeAnalyzer. If the type wasn't
        // already cached, we'll return an unknown type.
        let type = AnalyzerNodeInfo.getExpressionType(node);
        if (!type) {
            type = UnknownType.create();
        }

        return { type, node };
    }

    // Returns the type of one entry returned by the list comprehension,
    // as opposed to the entire list.
    private _getTypeFromListComprehensionExpression(node: ListComprehensionNode): TypeResult {
        let type = UnknownType.create();

        // TODO - need to implement
        return { type, node };
    }

    private _getTypeFromSliceExpression(node: SliceExpressionNode, flags: EvaluatorFlags): TypeResult {
        // TODO - need to implement
        if (node.startValue) {
            this._getTypeFromExpression(node.startValue,
                EvaluatorUsage.Get, EvaluatorFlags.None);
        }

        if (node.endValue) {
            this._getTypeFromExpression(node.endValue,
                EvaluatorUsage.Get, EvaluatorFlags.None);
        }

        if (node.stepValue) {
            this._getTypeFromExpression(node.stepValue,
                EvaluatorUsage.Get, EvaluatorFlags.None);
        }

        let type = ScopeUtils.getBuiltInType(this._scope, 'set') as ClassType;
        let convertedType: Type;
        if (type instanceof ClassType) {
            // TODO - infer set type
            type = type.cloneForSpecialization([UnknownType.create()]);

            convertedType = this._convertClassToObject(type);
        } else {
            convertedType = UnknownType.create();
        }

        return { type: convertedType, node };
    }

    // Converts the type parameters for a Callable type. It should
    // have zero to two parameters. The first parameter, if present, should be
    // either an ellipsis or a list of parameter types. The second parameter, if
    // present, should specify the return type.
    private _createCallableType(typeArgs?: TypeResult[]): FunctionType {
        let functionType = new FunctionType(FunctionTypeFlags.None);
        functionType.setDeclaredReturnType(AnyType.create());

        if (typeArgs && typeArgs.length > 0) {
            if (typeArgs[0].typeList) {
                typeArgs[0].typeList.forEach((entry, index) => {
                    if (entry.type instanceof AnyType && entry.type.isEllipsis()) {
                        this._addError(`'...' not allowed in this context`, entry.node);
                    } else if (entry.type instanceof ModuleType) {
                        this._addError(`Module not allowed in this context`, entry.node);
                    }

                    functionType.addParameter({
                        category: ParameterCategory.Simple,
                        name: `p${ index.toString() }`,
                        type: entry.type
                    });
                });
            } else if (typeArgs[0].type instanceof AnyType && typeArgs[0].type.isEllipsis()) {
                TypeUtils.addDefaultFunctionParameters(functionType);
            } else {
                this._addError(`Expected parameter type list or '...'`, typeArgs[0].node);
            }
        } else {
            TypeUtils.addDefaultFunctionParameters(functionType);
        }

        if (typeArgs && typeArgs.length > 1) {
            if (typeArgs[1].type instanceof AnyType && typeArgs[1].type.isEllipsis()) {
                this._addError(`'...' not allowed in this context`, typeArgs[1].node);
            } else if (typeArgs[1].type instanceof ModuleType) {
                this._addError(`Module not allowed in this context`, typeArgs[1].node);
            }
            functionType.setDeclaredReturnType(typeArgs[1].type);
        } else {
            functionType.setDeclaredReturnType(AnyType.create());
        }

        if (typeArgs && typeArgs.length > 2) {
            this._addError(`Expected only two type arguments to 'Callable'`, typeArgs[2].node);
        }

        return functionType;
    }

    // Creates an Optional[X, Y, Z] type.
    private _createOptionalType(errorNode: ExpressionNode, typeArgs?: TypeResult[]): Type {
        if (!typeArgs || typeArgs.length !== 1) {
            this._addError(`Expected one type parameter after Optional`, errorNode);
            return UnknownType.create();
        }

        if (typeArgs[0].type instanceof AnyType && typeArgs[0].type.isEllipsis()) {
            this._addError(`'...' not allowed in this context`, typeArgs[0].node);
        } else if (typeArgs[0].type instanceof ModuleType) {
            this._addError(`Module not allowed in this context`, typeArgs[0].node);
        }

        return TypeUtils.combineTypes([typeArgs[0].type, NoneType.create()]);
    }

    // Creates a ClassVar type.
    private _createClassVarType(typeArgs: TypeResult[] | undefined): Type {
        if (typeArgs && typeArgs.length > 1) {
            this._addError(`Expected only one type parameter after ClassVar`, typeArgs[1].node);
        }

        let type = (!typeArgs || typeArgs.length === 0) ? AnyType.create() : typeArgs[0].type;
        return this._convertClassToObject(type);
    }

    // Creates one of several "special" types that are defined in typing.pyi
    // but not declared in their entirety. This includes the likes of "Tuple",
    // "Dict", etc.
    private _createSpecialType(classType: ClassType, typeArgs: TypeResult[] | undefined,
            flags: EvaluatorFlags, paramLimit?: number, allowEllipsis = false): Type {

        let typeArgTypes = typeArgs ? typeArgs.map(t => t.type) : [];
        const typeArgCount = typeArgTypes.length;

        // Make sure the argument list count is correct.
        if (paramLimit !== undefined) {
            if (typeArgs && typeArgCount > paramLimit) {
                this._addError(
                    `Expected at most ${ paramLimit } type arguments`, typeArgs[paramLimit].node);
                typeArgTypes = typeArgTypes.slice(0, paramLimit);
            } else if (typeArgCount < paramLimit) {
                // Fill up the remainder of the slots with unknown types.
                while (typeArgTypes.length < paramLimit) {
                    typeArgTypes.push(UnknownType.create());
                }
            }
        }

        if (typeArgs) {
            // Verify that we didn't receive any inappropriate ellipses or modules.
            typeArgs.forEach((typeArg, index) => {
                if (typeArg.type instanceof AnyType && typeArg.type.isEllipsis()) {
                    if (!allowEllipsis || index !== typeArgs.length - 1) {
                        this._addError(`'...' not allowed in this context`, typeArgs[index].node);
                    }
                    if (typeArg.type instanceof ModuleType) {
                        this._addError(`Module not allowed in this context`, typeArg.node);
                    }
                }
            });
        }

        let specializedType = classType.cloneForSpecialization(typeArgTypes);

        return this._convertClassToObjectConditional(specializedType, flags);
    }

    // Unpacks the index expression for a "Union[X, Y, Z]" type annotation.
    private _createUnionType(typeArgs?: TypeResult[]): Type {
        let types: Type[] = [];

        if (typeArgs) {
            for (let typeArg of typeArgs) {
                types.push(typeArg.type);

                // Verify that we didn't receive any inappropriate ellipses.
                if (typeArg.type instanceof AnyType && typeArg.type.isEllipsis()) {
                    this._addError(`'...' not allowed in this context`, typeArg.node);
                } else if (typeArg.type instanceof ModuleType) {
                    this._addError(`Module not allowed in this context`, typeArg.node);
                }
            }
        }

        if (types.length > 0) {
            return TypeUtils.combineTypes(types);
        }

        return NeverType.create();
    }

    // Creates a type that represents "Generic[T1, T2, ...]", used in the
    // definition of a generic class.
    private _createGenericType(errorNode: ExpressionNode, classType: ClassType,
            typeArgs?: TypeResult[]): Type {

        // Make sure there's at least one type arg.
        if (!typeArgs || typeArgs.length === 0) {
            this._addError(
                `'Generic' requires at least one type argument`, errorNode);
        }

        // Make sure that all of the type args are typeVars and are unique.
        let uniqueTypeVars: TypeVarType[] = [];
        if (typeArgs) {
            typeArgs.forEach(typeArg => {
                if (!(typeArg.type instanceof TypeVarType)) {
                    this._addError(
                        `Type argument for 'Generic' must be a type variable`, typeArg.node);
                } else {
                    for (let typeVar of uniqueTypeVars) {
                        if (typeVar === typeArg.type) {
                            this._addError(
                                `Type argument for 'Generic' must be unique`, typeArg.node);
                            break;
                        }
                    }

                    uniqueTypeVars.push(typeArg.type);
                }
            });
        }

        return this._createSpecialType(classType, typeArgs, EvaluatorFlags.None);
    }

    private _createSpecializedClassType(classType: ClassType, typeArgs?: TypeResult[]): Type {
        let typeArgCount = typeArgs ? typeArgs.length : 0;

        // Make sure the argument list count is correct.
        let typeParameters = classType.getTypeParameters();

        // If there are no type parameters or args, the class is already specialized.
        // No need to do any more work.
        if (typeParameters.length === 0 && typeArgCount === 0) {
            return classType;
        }

        if (typeArgs && typeArgCount > typeParameters.length) {
            if (typeParameters.length === 0) {
                this._addError(`Expected no type arguments`,
                    typeArgs[typeParameters.length].node);
            } else {
                this._addError(
                    `Expected at most ${ typeParameters.length } type arguments`,
                    typeArgs[typeParameters.length].node);
            }
            typeArgCount = typeParameters.length;
        }

        if (typeArgs) {
            typeArgs.forEach(typeArg => {
                // Verify that we didn't receive any inappropriate ellipses or modules.
                if (typeArg.type instanceof AnyType && typeArg.type.isEllipsis()) {
                    this._addError(`'...' not allowed in this context`, typeArg.node);
                } else if (typeArg.type instanceof ModuleType) {
                    this._addError(`Module not allowed in this context`, typeArg.node);
                }
            });
        }

        // Fill in any missing type arguments with Any.
        let typeArgTypes = typeArgs ? typeArgs.map(t => t.type) : [];
        while (typeArgTypes.length < classType.getTypeParameters().length) {
            typeArgTypes.push(AnyType.create());
        }

        typeArgTypes.forEach((typeArgType, index) => {
            if (index < typeArgCount) {
                const diag = new DiagnosticAddendum();
                if (!TypeUtils.canAssignToTypeVar(typeParameters[index], typeArgType, diag)) {
                    this._addError(`Type '${ typeArgType.asString() }' ` +
                            `cannot be assigned to type variable '${ typeParameters[index].getName() }'` +
                            diag.getString(),
                        typeArgs![index].node);
                }
            }
        });

        let specializedClass = classType.cloneForSpecialization(typeArgTypes);

        return specializedClass;
    }

    private _applyTypeConstraint(node: ExpressionNode, unconstrainedType: Type): Type {
        // Shortcut the process if the type is unknown.
        if (unconstrainedType.isAny()) {
            return unconstrainedType;
        }

        // Apply constraints from the current scope and its outer scopes.
        let constrainedType = this._applyScopeTypeConstraintRecursive(
            node, unconstrainedType);

        // Apply constraints associated with the expression we're
        // currently walking.
        this._expressionTypeConstraints.forEach(constraint => {
            constrainedType = constraint.applyToType(node, constrainedType);
        });

        return constrainedType;
    }

    private _applyScopeTypeConstraintRecursive(node: ExpressionNode, type: Type,
            scope = this._scope): Type {
        // If we've hit a permanent scope, don't recurse any further.
        if (scope.getType() !== ScopeType.Temporary) {
            return type;
        }

        // Determine if any of the local constraints is blocking constraints
        // from parent scopes from being applied.
        let blockParentConstraints = false;
        for (let constraint of scope.getTypeConstraints()) {
            if (constraint.blockSubsequentContraints(node)) {
                blockParentConstraints = true;
                break;
            }
        }

        if (!blockParentConstraints) {
            // Recursively allow the parent scopes to apply their type constraints.
            const parentScope = scope.getParent();
            if (parentScope) {
                type = this._applyScopeTypeConstraintRecursive(node, type, parentScope);
            }
        }

        // Apply the constraints within the current scope. Stop if one of
        // them indicates that further constraints shouldn't be applied.
        for (let constraint of scope.getTypeConstraints()) {
            type = constraint.applyToType(node, type);

            if (constraint.blockSubsequentContraints(node)) {
                break;
            }
        }

        return type;
    }

    // Specializes the specified (potentially generic) class type using
    // the specified type arguments, reporting errors as appropriate.
    // Returns the specialized type and a boolean indicating whether
    // the type indicates a class type (true) or an object type (false).
    private _createSpecializeClassType(classType: ClassType, typeArgs: TypeResult[] | undefined,
            errorNode: ExpressionNode, flags: EvaluatorFlags): Type {

        // Handle the special-case classes that are not defined
        // in the type stubs.
        if (classType.isSpecialBuiltIn()) {
            const className = classType.getClassName();

            switch (className) {
                case 'Callable': {
                    return this._createCallableType(typeArgs);
                }

                case 'Optional': {
                    return this._createOptionalType(errorNode, typeArgs);
                }

                case 'Type': {
                    return this._createSpecialType(classType, typeArgs, flags, 1);
                }

                case 'ClassVar': {
                    // TODO - need to handle class vars. For now, we treat them
                    // like any other type.
                    return this._createClassVarType(typeArgs);
                }

                case 'Deque':
                case 'List':
                case 'FrozenSet':
                case 'Set': {
                    return this._createSpecialType(classType, typeArgs, flags, 1);
                }

                case 'ChainMap':
                case 'Dict':
                case 'DefaultDict': {
                    return this._createSpecialType(classType, typeArgs, flags, 2);
                }

                case 'Protocol': {
                    return this._createSpecialType(classType, typeArgs, flags, undefined);
                }

                case 'Tuple': {
                    return this._createSpecialType(classType, typeArgs, flags, undefined, true);
                }

                case 'Union': {
                    return this._createUnionType(typeArgs);
                }

                case 'Generic':
                    if (flags & EvaluatorFlags.ConvertClassToObject) {
                        this._addError(`Generic allowed only as base class`, errorNode);
                    }
                    return this._createGenericType(errorNode, classType, typeArgs);
            }
        }

        let specializedType = this._createSpecializedClassType(classType, typeArgs);
        return this._convertClassToObjectConditional(specializedType, flags);
    }

    private _convertClassToObjectConditional(type: Type, flags: EvaluatorFlags): Type {
        if (flags & EvaluatorFlags.ConvertClassToObject) {
           return this._convertClassToObject(type);
        }

        return type;
    }

    private _convertClassToObject(type: Type): Type {
        if (type instanceof ClassType) {
            type = new ObjectType(type);
        } else if (type instanceof UnionType) {
            return TypeUtils.doForSubtypes(type,
                subtype => this._convertClassToObject(subtype));
        }

        return type;
    }

    private _useExpressionTypeConstraint(typeConstraints:
            ConditionalTypeConstraintResults | undefined,
            useIfClause: boolean, callback: () => void) {

        // Push the specified constraints onto the list.
        let itemsToPop = 0;
        if (typeConstraints) {
            let constraintsToUse = useIfClause ?
                typeConstraints.ifConstraints : typeConstraints.elseConstraints;
            constraintsToUse.forEach(tc => {
                this._expressionTypeConstraints.push(tc);
                itemsToPop++;
            });
        }

        callback();

        // Clean up after ourself.
        for (let i = 0; i < itemsToPop; i++) {
            this._expressionTypeConstraints.pop();
        }
    }

    private _buildTypeConstraints(node: ExpressionNode) {
        return TypeConstraintBuilder.buildTypeConstraintsForConditional(node,
            (node: ExpressionNode) => this.getType(node,
                EvaluatorUsage.Get, EvaluatorFlags.None));
    }

    private _silenceDiagnostics(callback: () => void) {
        let oldDiagSink = this._diagnosticSink;
        this._diagnosticSink = undefined;

        callback();

        this._diagnosticSink = oldDiagSink;
    }

    private _addWarning(message: string, range: TextRange) {
        if (this._diagnosticSink) {
            this._diagnosticSink.addWarningWithTextRange(message, range);
        }
    }

    private _addError(message: string, range: TextRange) {
        if (this._diagnosticSink) {
            this._diagnosticSink.addErrorWithTextRange(message, range);
        }
    }

    private _addDiagnostic(diagLevel: DiagnosticLevel, message: string, textRange: TextRange) {
        if (diagLevel === 'error') {
            this._addError(message, textRange);
        } else if (diagLevel === 'warning') {
            this._addWarning(message, textRange);
        }
    }
}
