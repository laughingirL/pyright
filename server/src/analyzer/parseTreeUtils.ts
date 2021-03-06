/*
* parseTreeUtils.ts
* Copyright (c) Microsoft Corporation.
* Licensed under the MIT license.
* Author: Eric Traut
*
* Utility routines for traversing a parse tree.
*/

import { DiagnosticTextPosition } from '../common/diagnostic';
import { convertPositionToOffset } from '../common/positionUtils';
import { TextRange } from '../common/textRange';
import { TextRangeCollection } from '../common/textRangeCollection';
import { AssignmentNode, AugmentedAssignmentExpressionNode, AwaitExpressionNode,
    BinaryExpressionNode, CallExpressionNode, ClassNode, ConstantNode,
    DictionaryExpandEntryNode, DictionaryKeyEntryNode, DictionaryNode, EllipsisNode,
    ExpressionNode, FunctionNode, IndexExpressionNode, LambdaNode, ListComprehensionForNode,
    ListComprehensionNode, ListNode, MemberAccessExpressionNode, ModuleNode, NameNode,
    NumberNode, ParameterCategory, ParseNode, SetNode, SliceExpressionNode,
    TernaryExpressionNode, TupleExpressionNode, TypeAnnotationExpressionNode,
    UnaryExpressionNode, UnpackExpressionNode, YieldExpressionNode,
    YieldFromExpressionNode } from '../parser/parseNodes';
import { KeywordType, OperatorType } from '../parser/tokenizerTypes';

export class ParseTreeUtils {
    // Returns the deepest node that contains the specified position.
    static findNodeByPosition(node: ParseNode, position: DiagnosticTextPosition,
            lines: TextRangeCollection<TextRange>): ParseNode | undefined {

        let offset = convertPositionToOffset(position, lines);
        if (offset === undefined) {
            return undefined;
        }

        return ParseTreeUtils.findNodeByOffset(node, offset);
    }

    // Returns the deepest node that contains the specified offset.
    static findNodeByOffset(node: ParseNode, offset: number): ParseNode | undefined {
        if (offset < node.start || offset >= node.end) {
            return undefined;
        }

        // The range is found within this node. See if we can localize it
        // further by checking its children.
        let children = node.getChildrenFlattened();
        for (let child of children) {
            let containingChild = ParseTreeUtils.findNodeByOffset(child, offset);
            if (containingChild) {
                return containingChild;
            }
        }

        return node;
    }

    static printExpression(node: ExpressionNode): string {
        if (node instanceof NameNode) {
            return node.nameToken.value;
        } else if (node instanceof MemberAccessExpressionNode) {
            return ParseTreeUtils.printExpression(node.leftExpression) + '.' +
                node.memberName.nameToken.value;
        } else if (node instanceof CallExpressionNode) {
            return ParseTreeUtils.printExpression(node.leftExpression) + '(' +
                node.arguments.map(arg => this.printExpression(arg.valueExpression)).join(', ') +
                ')';
        } else if (node instanceof IndexExpressionNode) {
            return ParseTreeUtils.printExpression(node.baseExpression) + '[' +
                node.items.items.map(item => this.printExpression(item)).join(', ') +
                ']';
        } else if (node instanceof UnaryExpressionNode) {
            return ParseTreeUtils.printOperator(node.operator) + ' ' +
                ParseTreeUtils.printExpression(node.expression);
        } else if (node instanceof BinaryExpressionNode) {
            return ParseTreeUtils.printExpression(node.leftExpression) + ' ' +
                ParseTreeUtils.printOperator(node.operator) + ' ' +
                ParseTreeUtils.printExpression(node.rightExpression);
        } else if (node instanceof NumberNode) {
            return node.token.value.toString();
        } else if (node instanceof AssignmentNode) {
            return ParseTreeUtils.printExpression(node.leftExpression) + ' = ' +
                ParseTreeUtils.printExpression(node.rightExpression);
        } else if (node instanceof TypeAnnotationExpressionNode) {
            return ParseTreeUtils.printExpression(node.valueExpression) + ': ' +
                ParseTreeUtils.printExpression(node.typeAnnotation);
        } else if (node instanceof AugmentedAssignmentExpressionNode) {
            return ParseTreeUtils.printExpression(node.leftExpression) + ' ' +
                ParseTreeUtils.printOperator(node.operator) + ' ' +
                ParseTreeUtils.printExpression(node.rightExpression);
        } else if (node instanceof AwaitExpressionNode) {
            return 'await ' + ParseTreeUtils.printExpression(node.expression);
        } else if (node instanceof TernaryExpressionNode) {
            return ParseTreeUtils.printExpression(node.ifExpression) + ' if ' +
                ParseTreeUtils.printExpression(node.testExpression) + ' else ' +
                ParseTreeUtils.printExpression(node.elseExpression);
        } else if (node instanceof ListNode) {
            let expressions = node.entries.map(expr => {
                return ParseTreeUtils.printExpression(expr);
            });
            return `[${ expressions.join(', ') }]`;
        } else if (node instanceof UnpackExpressionNode) {
            return '*' + ParseTreeUtils.printExpression(node.expression);
        } else if (node instanceof TupleExpressionNode) {
            let expressions = node.expressions.map(expr => {
                return ParseTreeUtils.printExpression(expr);
            });
            if (expressions.length === 1) {
                return `(${ expressions[0] }, )`;
            }
            return `(${ expressions.join(', ') })`;
        } else if (node instanceof YieldExpressionNode) {
            return 'yield ' + ParseTreeUtils.printExpression(node.expression);
        } else if (node instanceof YieldFromExpressionNode) {
            return 'yield from ' + ParseTreeUtils.printExpression(node.expression);
        } else if (node instanceof EllipsisNode) {
            return '...';
        } else if (node instanceof ListComprehensionNode) {
            return node.comprehensions.map(expr => {
                if (expr instanceof ListComprehensionForNode) {
                    return `${ expr.isAsync ? 'async ' : '' }for` +
                        ParseTreeUtils.printExpression(expr.targetExpression) +
                        ` in ${ ParseTreeUtils.printExpression(expr.iterableExpression) }`;
                } else {
                    return `if ${ ParseTreeUtils.printExpression(expr.testExpression) }`;
                }
            }).join(' ');
        } else if (node instanceof SliceExpressionNode) {
            let result = '';
            if (node.startValue) {
                result += ParseTreeUtils.printExpression(node.startValue);
            }
            if (node.endValue) {
                result += ': ' + ParseTreeUtils.printExpression(node.endValue);
            }
            if (node.stepValue) {
                result += ': ' + ParseTreeUtils.printExpression(node.stepValue);
            }
            return result;
        } else if (node instanceof LambdaNode) {
            return 'lambda ' + node.parameters.map(param => {
                let paramStr = '';

                if (param.category === ParameterCategory.VarArgList) {
                    paramStr += '*';
                } else if (param.category === ParameterCategory.VarArgDictionary) {
                    paramStr += '**';
                }

                if (param.name) {
                    paramStr += param.name;
                }

                if (param.defaultValue) {
                    paramStr += ' = ' + ParseTreeUtils.printExpression(param.defaultValue);
                }
                return paramStr;
            }).join(', ') + ': ' + ParseTreeUtils.printExpression(node.expression);
        } else if (node instanceof ConstantNode) {
            if (node.token.keywordType === KeywordType.True) {
                return 'True';
            } else if (node.token.keywordType === KeywordType.False) {
                return 'False';
            } else if (node.token.keywordType === KeywordType.Debug) {
                return '__debug__';
            } else if (node.token.keywordType === KeywordType.None) {
                return 'None';
            }
        } else if (node instanceof DictionaryNode) {
            return `{ ${ node.entries.map(entry => {
                if (entry instanceof DictionaryKeyEntryNode) {
                    return `${ ParseTreeUtils.printExpression(entry.keyExpression) }: ` +
                        `${ ParseTreeUtils.printExpression(entry.valueExpression) }`;
                } else {
                    return ParseTreeUtils.printExpression(entry);
                }
            })} }`;
        } else if (node instanceof DictionaryExpandEntryNode) {
            return `**${ ParseTreeUtils.printExpression(node.expandExpression) }`;
        } else if (node instanceof SetNode) {
            return node.entries.map(entry => ParseTreeUtils.printExpression(entry)).join(', ');
        }

        return '<Expression>';
    }

    static printOperator(operator: OperatorType): string {
        const operatorMap: { [operator: number]: string } = {
            [OperatorType.Add]: '+',
            [OperatorType.AddEqual]: '+=',
            [OperatorType.Assign]: '=',
            [OperatorType.BitwiseAnd]: '&',
            [OperatorType.BitwiseAndEqual]: '&=',
            [OperatorType.BitwiseInvert]: '~',
            [OperatorType.BitwiseOr]: '|',
            [OperatorType.BitwiseOrEqual]: '|=',
            [OperatorType.BitwiseXor]: '^',
            [OperatorType.BitwiseXorEqual]: '^=',
            [OperatorType.Divide]: '/',
            [OperatorType.DivideEqual]: '/=',
            [OperatorType.Equals]: '==',
            [OperatorType.FloorDivide]: '//',
            [OperatorType.FloorDivideEqual]: '//=',
            [OperatorType.GreaterThan]: '>',
            [OperatorType.GreaterThanOrEqual]: '>=',
            [OperatorType.LeftShift]: '<<',
            [OperatorType.LeftShiftEqual]: '<<=',
            [OperatorType.LessThan]: '<',
            [OperatorType.LessThanOrEqual]: '<=',
            [OperatorType.MatrixMultiply]: '@',
            [OperatorType.MatrixMultiplyEqual]: '@=',
            [OperatorType.Mod]: '%',
            [OperatorType.ModEqual]: '%=',
            [OperatorType.Multiply]: '*',
            [OperatorType.MultiplyEqual]: '*=',
            [OperatorType.NotEquals]: '!=',
            [OperatorType.Power]: '**',
            [OperatorType.PowerEqual]: '**=',
            [OperatorType.RightShift]: '>>',
            [OperatorType.RightShiftEqual]: '>>=',
            [OperatorType.Subtract]: '-',
            [OperatorType.SubtractEqual]: '-=',
            [OperatorType.And]: 'and',
            [OperatorType.Or]: 'or',
            [OperatorType.Not]: 'not',
            [OperatorType.Is]: 'is',
            [OperatorType.IsNot]: 'is not',
            [OperatorType.In]: 'in',
            [OperatorType.NotIn]: 'not in'
        };

        if (operatorMap[operator]) {
            return operatorMap[operator];
        }

        return 'unknown';
    }

    static getEnclosingClass(node: ParseNode, stopAtFunction = false): ClassNode | undefined {
        let curNode = node.parent;
        while (curNode) {
            if (curNode instanceof ClassNode) {
                return curNode;
            }

            if (curNode instanceof ModuleNode) {
                return undefined;
            }

            if (curNode instanceof FunctionNode) {
                if (stopAtFunction) {
                    return undefined;
                }
            }

            curNode = curNode.parent;
        }

        return undefined;
    }

    static getEnclosingFunction(node: ParseNode): FunctionNode | undefined {
        let curNode = node.parent;
        while (curNode) {
            if (curNode instanceof FunctionNode) {
                return curNode;
            }
            if (curNode instanceof ClassNode) {
                return undefined;
            }

            curNode = curNode.parent;
        }

        return undefined;
    }
}
