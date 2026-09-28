import {
  createSourceFile,
  ScriptTarget,
  ScriptKind,
  SyntaxKind,
  isFunctionDeclaration,
  isClassDeclaration,
  isMethodDeclaration,
  isGetAccessorDeclaration,
  isSetAccessorDeclaration,
  isVariableStatement,
  isIdentifier,
  isFunctionExpression,
  isArrowFunction,
  isClassExpression,
  isExportAssignment,
  type SourceFile,
  type Node,
  type ClassDeclaration,
} from "typescript";
import type { Doc, Segment } from "../contracts.ts";
import { makeSeg } from "./common.ts";

function nameOf(node: Node, source: SourceFile): string | null {
  switch (node.kind) {
    case SyntaxKind.FunctionDeclaration: {
      if (!isFunctionDeclaration(node) || !node.name) return null;
      return node.name.text;
    }
    case SyntaxKind.ClassDeclaration: {
      if (!isClassDeclaration(node) || !node.name) return null;
      return node.name.text;
    }
    case SyntaxKind.MethodDeclaration: {
      if (!isMethodDeclaration(node)) return null;
      return isIdentifier(node.name) ? node.name.text : null;
    }
    case SyntaxKind.Constructor: {
      return "constructor";
    }
    case SyntaxKind.GetAccessor: {
      if (!isGetAccessorDeclaration(node) || !isIdentifier(node.name)) return null;
      return `get ${node.name.text}`;
    }
    case SyntaxKind.SetAccessor: {
      if (!isSetAccessorDeclaration(node) || !isIdentifier(node.name)) return null;
      return `set ${node.name.text}`;
    }
    case SyntaxKind.VariableStatement: {
      if (!isVariableStatement(node)) return null;
      for (const decl of node.declarationList.declarations) {
        if (!isIdentifier(decl.name) || !decl.initializer) continue;
        const init = decl.initializer;
        const fnLike =
          isFunctionExpression(init) ||
          isArrowFunction(init) ||
          isClassExpression(init);
        if (fnLike) return decl.name.text;
      }
      return null;
    }
    case SyntaxKind.ExportAssignment: {
      if (!isExportAssignment(node)) return null;
      return "default";
    }
    default:
      void source;
      return null;
  }
}

function lineOf(source: SourceFile, pos: number): number {
  return source.getLineAndCharacterOfPosition(pos).line + 1;
}

function kindForPath(path: string): ScriptKind {
  if (/\.tsx$/i.test(path) || /\.jsx$/i.test(path)) return ScriptKind.TSX;
  if (/\.(js|mjs|cjs)$/i.test(path)) return ScriptKind.JS;
  return ScriptKind.TS;
}

function methodMembers(cls: ClassDeclaration): Node[] {
  const found: Node[] = [];
  for (const member of cls.members) {
    const k = member.kind;
    if (
      k === SyntaxKind.MethodDeclaration ||
      k === SyntaxKind.Constructor ||
      k === SyntaxKind.GetAccessor ||
      k === SyntaxKind.SetAccessor
    ) {
      found.push(member);
    }
  }
  return found;
}

export function segmentScript(doc: Doc, lines: string[]): Segment[] | null {
  let source: SourceFile;
  try {
    source = createSourceFile(
      doc.rel,
      doc.body,
      ScriptTarget.Latest,
      true,
      kindForPath(doc.rel),
    );
  } catch {
    return null;
  }

  const out: Segment[] = [];

  const pushNode = (node: Node, title: string) => {
    const start = lineOf(source, node.getStart(source, false));
    const end = lineOf(source, node.end);
    out.push(
      makeSeg(doc, title, { from: start, to: end }, "declaration", lines),
    );
  };

  for (const stmt of source.statements) {
    if (isFunctionDeclaration(stmt)) {
      const n = nameOf(stmt, source);
      if (n) pushNode(stmt, n);
      continue;
    }
    if (stmt.kind === SyntaxKind.ClassDeclaration && isClassDeclaration(stmt)) {
      const className = nameOf(stmt, source) ?? "Class";
      const methods = methodMembers(stmt);
      pushNode(stmt, className);
      for (const member of methods) {
        const n = nameOf(member, source);
        if (n) pushNode(member, n);
      }
      continue;
    }
    if (isVariableStatement(stmt)) {
      const n = nameOf(stmt, source);
      if (n) pushNode(stmt, n);
    }
  }

  if (out.length === 0) return null;
  return out;
}
