/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {HtmlParser, Node, ParseTreeResult, visitAll} from '@angular/compiler';
import {dirname, join} from 'path';
import ts from 'typescript';

import {AnalyzedFile, boundngif, CaseCollector, ElementCollector, ElementToMigrate, MigrateError, nakedngif, ngfor, ngif, ngswitch, Result, Template} from './types';

/**
 * Analyzes a source file to find file that need to be migrated and the text ranges within them.
 * @param sourceFile File to be analyzed.
 * @param analyzedFiles Map in which to store the results.
 */
export function analyze(sourceFile: ts.SourceFile, analyzedFiles: Map<string, AnalyzedFile>) {
  for (const node of sourceFile.statements) {
    if (!ts.isClassDeclaration(node)) {
      continue;
    }

    // Note: we have a utility to resolve the Angular decorators from a class declaration already.
    // We don't use it here, because it requires access to the type checker which makes it more
    // time-consuming to run internally.
    const decorator = ts.getDecorators(node)?.find(dec => {
      return ts.isCallExpression(dec.expression) && ts.isIdentifier(dec.expression.expression) &&
          dec.expression.expression.text === 'Component';
    }) as (ts.Decorator & {expression: ts.CallExpression}) |
        undefined;

    const metadata = decorator && decorator.expression.arguments.length > 0 &&
            ts.isObjectLiteralExpression(decorator.expression.arguments[0]) ?
        decorator.expression.arguments[0] :
        null;

    if (!metadata) {
      continue;
    }

    for (const prop of metadata.properties) {
      // All the properties we care about should have static
      // names and be initialized to a static string.
      if (!ts.isPropertyAssignment(prop) || !ts.isStringLiteralLike(prop.initializer) ||
          (!ts.isIdentifier(prop.name) && !ts.isStringLiteralLike(prop.name))) {
        continue;
      }

      switch (prop.name.text) {
        case 'template':
          // +1/-1 to exclude the opening/closing characters from the range.
          AnalyzedFile.addRange(
              sourceFile.fileName, analyzedFiles,
              [prop.initializer.getStart() + 1, prop.initializer.getEnd() - 1]);
          break;

        case 'templateUrl':
          // Leave the end as undefined which means that the range is until the end of the file.
          const path = join(dirname(sourceFile.fileName), prop.initializer.text);
          AnalyzedFile.addRange(path, analyzedFiles, [0]);
          break;
      }
    }
  }
}

/**
 * returns the level deep a migratable element is nested
 */
function getNestedCount(etm: ElementToMigrate, aggregator: number[]) {
  if (aggregator.length === 0) {
    return 0;
  }
  if (etm.el.sourceSpan.start.offset < aggregator[aggregator.length - 1] &&
      etm.el.sourceSpan.end.offset !== aggregator[aggregator.length - 1]) {
    // element is nested
    aggregator.push(etm.el.sourceSpan.end.offset);
    return aggregator.length - 1;
  } else {
    // not nested
    aggregator.pop()!;
    return getNestedCount(etm, aggregator);
  }
}

const lb = '\n';

/**
 * Replaces structural directive control flow instances with block control flow equivalents.
 * Returns null if the migration failed (e.g. there was a syntax error).
 */
export function migrateTemplate(template: string): {migrated: string|null, errors: MigrateError[]} {
  let parsed: ParseTreeResult;
  let errors: MigrateError[] = [];
  try {
    // Note: we use the HtmlParser here, instead of the `parseTemplate` function, because the
    // latter returns an Ivy AST, not an HTML AST. The HTML AST has the advantage of preserving
    // interpolated text as text nodes containing a mixture of interpolation tokens and text tokens,
    // rather than turning them into `BoundText` nodes like the Ivy AST does. This allows us to
    // easily get the text-only ranges without having to reconstruct the original text.
    parsed = new HtmlParser().parse(template, '', {
      // Allows for ICUs to be parsed.
      tokenizeExpansionForms: true,
      // Explicitly disable blocks so that their characters are treated as plain text.
      tokenizeBlocks: false,
      preserveLineEndings: true,
    });

    // Don't migrate invalid templates.
    if (parsed.errors && parsed.errors.length > 0) {
      for (let error of parsed.errors) {
        errors.push({type: 'parse', error});
      }
      return {migrated: null, errors};
    }
  } catch (error: unknown) {
    errors.push({type: 'parse', error});
    return {migrated: null, errors};
  }

  let result = template;
  const lineBreaks = template.match(/\r|\n/g);
  const hasLineBreaks = lineBreaks !== null;

  const visitor = new ElementCollector();
  visitAll(visitor, parsed.rootNodes);

  // count usages of each ng-template
  for (let [key, tmpl] of visitor.templates) {
    const regex = new RegExp(`\\W${key.slice(1)}\\W`, 'gm');
    const matches = template.match(regex);
    tmpl.count = matches?.length ?? 0;
    tmpl.generateContents(template);
  }

  // start from top of template
  // loop through each element
  let prevElEnd = visitor.elements[0]?.el.sourceSpan.end.offset ?? result.length - 1;
  let nestedQueue: number[] = [prevElEnd];
  for (let i = 1; i < visitor.elements.length; i++) {
    let currEl = visitor.elements[i];
    currEl.nestCount = getNestedCount(currEl, nestedQueue);
    if (currEl.el.sourceSpan.end.offset !== nestedQueue[nestedQueue.length - 1]) {
      nestedQueue.push(currEl.el.sourceSpan.end.offset);
    }
  }

  // this tracks the character shift from different lengths of blocks from
  // the prior directives so as to adjust for nested block replacement during
  // migration. Each block calculates length differences and passes that offset
  // to the next migrating block to adjust character offsets properly.
  let offset = 0;
  let nestLevel = -1;
  let postOffsets: number[] = [];
  let migrateResult: Result = {tmpl: result, offsets: {pre: 0, post: 0}};
  for (const el of visitor.elements) {
    // applies the post offsets after closing
    if (el.nestCount <= nestLevel) {
      const count = nestLevel - el.nestCount;
      // reduced nesting, add postoffset
      for (let i = 0; i <= count; i++) {
        offset += postOffsets.pop() ?? 0;
      }
    }

    // these are all migratable nodes
    if (el.attr.name === ngif || el.attr.name === nakedngif || el.attr.name === boundngif) {
      try {
        migrateResult = migrateNgIf(el, visitor.templates, result, offset, hasLineBreaks);
      } catch (error: unknown) {
        errors.push({type: ngif, error});
      }
    } else if (el.attr.name === ngfor) {
      try {
        migrateResult = migrateNgFor(el, result, offset, hasLineBreaks);
      } catch (error: unknown) {
        errors.push({type: ngfor, error});
      }
    } else if (el.attr.name === ngswitch) {
      try {
        migrateResult = migrateNgSwitch(el, result, offset, hasLineBreaks);
      } catch (error: unknown) {
        errors.push({type: ngswitch, error});
      }
    }
    result = migrateResult.tmpl;
    offset += migrateResult.offsets.pre;
    postOffsets.push(migrateResult.offsets.post);
    const nm = el.el.name;
    nestLevel = el.nestCount;
  }

  for (const [_, t] of visitor.templates) {
    if (t.count < 2 && t.used) {
      result = result.replace(t.contents, '');
    }
  }

  return {migrated: result, errors};
}

function migrateNgIf(
    etm: ElementToMigrate, ngTemplates: Map<string, Template>, tmpl: string, offset: number,
    hasLineBreaks: boolean): Result {
  const matchThen = etm.attr.value.match(/;\s+then/gm);
  const matchElse = etm.attr.value.match(/;\s+else/gm);

  if (matchThen && matchThen.length > 0) {
    return buildIfThenElseBlock(
        etm, ngTemplates, tmpl, matchThen[0], matchElse![0], offset, hasLineBreaks);
  } else if (matchElse && matchElse.length > 0) {
    // just else
    return buildIfElseBlock(etm, ngTemplates, tmpl, matchElse[0], offset, hasLineBreaks);
  }

  return buildIfBlock(etm, tmpl, offset, hasLineBreaks);
}

function buildIfBlock(
    etm: ElementToMigrate, tmpl: string, offset: number, hasLineBreaks: boolean): Result {
  // includes the mandatory semicolon before as
  const lbString = hasLineBreaks ? lb : '';
  const condition = etm.attr.value.replace(' as ', '; as ');

  const originals = getOriginals(etm, tmpl, offset);

  const {start, middle, end} = getMainBlock(etm, tmpl, offset);
  const startBlock = `@if (${condition}) {${lbString}${start}`;
  const endBlock = `${end}${lbString}}`;

  const ifBlock = startBlock + middle + endBlock;
  const updatedTmpl = tmpl.slice(0, etm.start(offset)) + ifBlock + tmpl.slice(etm.end(offset));

  // this should be the difference between the starting element up to the start of the closing
  // element and the mainblock sans }
  const pre = originals.start.length - startBlock.length;
  const post = originals.end.length - endBlock.length;

  return {tmpl: updatedTmpl, offsets: {pre, post}};
}

function buildIfElseBlock(
    etm: ElementToMigrate, ngTemplates: Map<string, Template>, tmpl: string, elseString: string,
    offset: number, hasLineBreaks: boolean): Result {
  // includes the mandatory semicolon before as
  const lbString = hasLineBreaks ? lb : '';
  const condition = etm.getCondition(elseString).replace(' as ', '; as ');

  const originals = getOriginals(etm, tmpl, offset);

  const elseTmpl = ngTemplates.get(`#${etm.getTemplateName(elseString)}`)!;
  const {start, middle, end} = getMainBlock(etm, tmpl, offset);
  const startBlock = `@if (${condition}) {${lbString}${start}`;

  const elseBlock = `${end}${lbString}} @else {${lbString}`;
  const postBlock = elseBlock + elseTmpl.children + `${lbString}}`;
  const ifElseBlock = startBlock + middle + postBlock;

  const tmplStart = tmpl.slice(0, etm.start(offset));
  const tmplEnd = tmpl.slice(etm.end(offset));
  const updatedTmpl = tmplStart + ifElseBlock + tmplEnd;

  // decrease usage count of elseTmpl
  elseTmpl.count--;
  elseTmpl.used = true;

  const pre = originals.start.length - startBlock.length;
  const post = originals.end.length - postBlock.length;

  return {tmpl: updatedTmpl, offsets: {pre, post}};
}

function buildIfThenElseBlock(
    etm: ElementToMigrate, ngTemplates: Map<string, Template>, tmpl: string, thenString: string,
    elseString: string, offset: number, hasLineBreaks: boolean): Result {
  const condition = etm.getCondition(thenString).replace(' as ', '; as ');
  const lbString = hasLineBreaks ? lb : '';

  const originals = getOriginals(etm, tmpl, offset);

  const startBlock = `@if (${condition}) {${lbString}`;
  const elseBlock = `${lbString}} @else {${lbString}`;

  const thenTmpl = ngTemplates.get(`#${etm.getTemplateName(thenString, elseString)}`)!;
  const elseTmpl = ngTemplates.get(`#${etm.getTemplateName(elseString)}`)!;

  const postBlock = thenTmpl.children + elseBlock + elseTmpl.children + `${lbString}}`;
  const ifThenElseBlock = startBlock + postBlock;

  const tmplStart = tmpl.slice(0, etm.start(offset));
  const tmplEnd = tmpl.slice(etm.end(offset));

  const updatedTmpl = tmplStart + ifThenElseBlock + tmplEnd;

  // decrease usage count of thenTmpl and elseTmpl
  thenTmpl.count--;
  thenTmpl.used = true;
  elseTmpl.count--;
  elseTmpl.used = true;

  const pre = originals.start.length - startBlock.length;
  const post = originals.end.length - postBlock.length;

  return {tmpl: updatedTmpl, offsets: {pre, post}};
}

function migrateNgFor(
    etm: ElementToMigrate, tmpl: string, offset: number, hasLineBreaks: boolean): Result {
  const aliasWithEqualRegexp = /=\s+(count|index|first|last|even|odd)/gm;
  const aliasWithAsRegexp = /(count|index|first|last|even|odd)\s+as/gm;
  const aliases = [];
  const lbString = hasLineBreaks ? lb : '';
  const lbSpaces = hasLineBreaks ? `${lb}  ` : '';
  const parts = etm.attr.value.split(';');

  const originals = getOriginals(etm, tmpl, offset);

  // first portion should always be the loop definition prefixed with `let`
  const condition = parts[0].replace('let ', '');
  const loopVar = condition.split(' of ')[0];
  let trackBy = loopVar;
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i].trim();

    if (part.startsWith('trackBy:')) {
      // build trackby value
      const trackByFn = part.replace('trackBy:', '').trim();
      trackBy = `${trackByFn}($index, ${loopVar})`;
    }
    // aliases
    // declared with `let myIndex = index`
    if (part.match(aliasWithEqualRegexp)) {
      // 'let myIndex = index' -> ['let myIndex', 'index']
      const aliasParts = part.split('=');
      // -> 'let myIndex = $index'
      aliases.push(` ${aliasParts[0].trim()} = $${aliasParts[1].trim()}`);
    }
    // declared with `index as myIndex`
    if (part.match(aliasWithAsRegexp)) {
      // 'index    as   myIndex' -> ['index', 'myIndex']
      const aliasParts = part.split(/\s+as\s+/);
      // -> 'let myIndex = $index'
      aliases.push(` let ${aliasParts[1].trim()} = $${aliasParts[0].trim()}`);
    }
  }

  const aliasStr = (aliases.length > 0) ? `;${aliases.join(';')}` : '';

  const {start, middle, end} = getMainBlock(etm, tmpl, offset);
  const startBlock = `@for (${condition}; track ${trackBy}${aliasStr}) {${lbSpaces}${start}`;

  const endBlock = `${end}${lbString}}`;
  const forBlock = startBlock + middle + endBlock;

  const updatedTmpl = tmpl.slice(0, etm.start(offset)) + forBlock + tmpl.slice(etm.end(offset));

  const pre = originals.start.length - startBlock.length;
  const post = originals.end.length - endBlock.length;

  return {tmpl: updatedTmpl, offsets: {pre, post}};
}

function getOriginals(
    etm: ElementToMigrate, tmpl: string, offset: number): {start: string, end: string} {
  // original opening block
  if (etm.el.children.length > 0) {
    const start = tmpl.slice(
        etm.el.sourceSpan.start.offset - offset,
        etm.el.children[0].sourceSpan.start.offset - offset);
    // original closing block
    const end = tmpl.slice(
        etm.el.children[etm.el.children.length - 1].sourceSpan.end.offset - offset,
        etm.el.sourceSpan.end.offset - offset);
    return {start, end};
  }
  // self closing or no children
  const start =
      tmpl.slice(etm.el.sourceSpan.start.offset - offset, etm.el.sourceSpan.end.offset - offset);
  // original closing block
  return {start, end: ''};
}

function getMainBlock(etm: ElementToMigrate, tmpl: string, offset: number):
    {start: string, middle: string, end: string} {
  if (etm.el.name === 'ng-container' && etm.el.attrs.length === 1) {
    // this is the case where we're migrating and there's no need to keep the ng-container
    const childStart = etm.el.children[0].sourceSpan.start.offset - offset;
    const childEnd = etm.el.children[etm.el.children.length - 1].sourceSpan.end.offset - offset;
    const middle = tmpl.slice(childStart, childEnd);
    return {start: '', middle, end: ''};
  }

  const attrStart = etm.attr.keySpan!.start.offset - 1 - offset;
  const valEnd = etm.attr.valueSpan!.end.offset + 1 - offset;
  let childStart = valEnd;
  let childEnd = valEnd;

  if (etm.el.children.length > 0) {
    childStart = etm.el.children[0].sourceSpan.start.offset - offset;
    childEnd = etm.el.children[etm.el.children.length - 1].sourceSpan.end.offset - offset;
  }

  let start = tmpl.slice(etm.start(offset), attrStart);
  start += tmpl.slice(valEnd, childStart);
  const middle = tmpl.slice(childStart, childEnd);
  const end = tmpl.slice(childEnd, etm.end(offset));

  return {start, middle, end};
}

function migrateNgSwitch(
    etm: ElementToMigrate, tmpl: string, offset: number, hasLineBreaks: boolean): Result {
  const condition = etm.attr.value;
  const startBlock = `@switch (${condition}) {`;
  const lbString = hasLineBreaks ? lb : '';

  const {openTag, closeTag, children} = getSwitchBlockElements(etm, tmpl, offset);
  const cases = getSwitchCases(children, tmpl, offset, hasLineBreaks);
  const switchBlock = openTag + startBlock + cases.join('') + `${lbString}}` + closeTag;
  const updatedTmpl = tmpl.slice(0, etm.start(offset)) + switchBlock + tmpl.slice(etm.end(offset));
  const pre = etm.length() - switchBlock.length;

  return {tmpl: updatedTmpl, offsets: {pre, post: 0}};
}

function getSwitchBlockElements(etm: ElementToMigrate, tmpl: string, offset: number) {
  const attrStart = etm.attr.keySpan!.start.offset - 1 - offset;
  const valEnd = etm.attr.valueSpan!.end.offset + 1 - offset;
  const childStart = etm.el.children[0].sourceSpan.start.offset - offset;
  const childEnd = etm.el.children[etm.el.children.length - 1].sourceSpan.end.offset - offset;
  let openTag = (etm.el.name === 'ng-container') ?
      '' :
      tmpl.slice(etm.start(offset), attrStart) + tmpl.slice(valEnd, childStart);
  if (tmpl.slice(childStart, childStart + 1) === lb) {
    openTag += lb;
  }
  let closeTag = (etm.el.name === 'ng-container') ? '' : tmpl.slice(childEnd, etm.end(offset));
  if (tmpl.slice(childEnd - 1, childEnd) === lb) {
    closeTag = lb + closeTag;
  }
  return {
    openTag,
    closeTag,
    children: etm.el.children,
  };
}

function getSwitchCases(children: Node[], tmpl: string, offset: number, hasLineBreaks: boolean) {
  const collector = new CaseCollector();
  visitAll(collector, children);
  return collector.elements.map(etm => getSwitchCaseBlock(etm, tmpl, offset, hasLineBreaks));
}

function getSwitchCaseBlock(
    etm: ElementToMigrate, tmpl: string, offset: number, hasLineBreaks: boolean): string {
  let elStart = etm.el.sourceSpan?.start.offset - offset;
  let elEnd = etm.el.sourceSpan?.end.offset - offset;
  const lbString = hasLineBreaks ? '\n  ' : ' ';
  const lbSpaces = hasLineBreaks ? '  ' : '';
  let shift = 0;

  if ((etm.el.name === 'ng-container' || etm.el.name === 'ng-template') &&
      etm.el.attrs.length === 1) {
    // no need to keep the containers
    elStart = etm.el.children[0].sourceSpan.start.offset - offset;
    elEnd = etm.el.children[etm.el.children.length - 1].sourceSpan.end.offset - offset;
    // account for the `>` that isn't needed
    shift += 1;
  }

  const attrStart = etm.attr.keySpan!.start.offset - 1 - offset + shift;
  // ngSwitchDefault case has no valueSpan and relies on the end of the key
  if (etm.attr.name === '*ngSwitchDefault' || etm.attr.name === 'ngSwitchDefault') {
    const attrEnd = etm.attr.keySpan!.end.offset - offset + shift;
    return `${lbString}@default {${lbString}${lbSpaces}${
        tmpl.slice(elStart, attrStart) + tmpl.slice(attrEnd, elEnd)}${lbString}}`;
  }
  // ngSwitchCase has a valueSpan
  let valEnd = etm.attr.valueSpan!.end.offset + 1 - offset + shift;
  return `${lbString}@case (${etm.attr.value}) {${lbString}${lbSpaces}${
      tmpl.slice(elStart, attrStart) + tmpl.slice(valEnd, elEnd)}${lbString}}`;
}
