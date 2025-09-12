import PDFArray from './objects/PDFArray';
import PDFDict from './objects/PDFDict';
import PDFName from './objects/PDFName';
import PDFObject from './objects/PDFObject';
import PDFRef from './objects/PDFRef';
import PDFStream from './objects/PDFStream';
import PDFString from './objects/PDFString';
import PDFInvalidObject from './objects/PDFInvalidObject';
import PDFContext from './PDFContext';
import PDFPageLeaf from './structures/PDFPageLeaf';

/**
 * PDFObjectCopier copies PDFObjects from a src context to a dest context.
 * The primary use case for this is to copy pages between PDFs.
 *
 * _Copying_ an object with a PDFObjectCopier is different from _cloning_ an
 * object with its [[PDFObject.clone]] method:
 *
 * ```
 *   const src: PDFContext = ...
 *   const dest: PDFContext = ...
 *   const originalObject: PDFObject = ...
 *   const copiedObject = PDFObjectCopier.for(src, dest).copy(originalObject);
 *   const clonedObject = originalObject.clone();
 * ```
 *
 * Copying an object is equivalent to cloning it and then copying over any other
 * objects that it references. Note that only dictionaries, arrays, and streams
 * (or structures build from them) can contain indirect references to other
 * objects. Copying a PDFObject that is not a dictionary, array, or stream is
 * supported, but is equivalent to cloning it.
 */
class PDFObjectCopier {
  static for = (src: PDFContext, dest: PDFContext) =>
    new PDFObjectCopier(src, dest);

  private readonly src: PDFContext;
  private readonly dest: PDFContext;
  private readonly traversedObjects = new Map<PDFObject, PDFObject>();

  private constructor(src: PDFContext, dest: PDFContext) {
    this.src = src;
    this.dest = dest;
  }

  // prettier-ignore
  copy = <T extends PDFObject>(object: T): T => (
    object instanceof PDFPageLeaf ? this.copyPDFPage(object)
      : object instanceof PDFDict ? this.copyPDFDict(object)
        : object instanceof PDFArray ? this.copyPDFArray(object)
          : object instanceof PDFStream ? this.copyPDFStream(object)
            : object instanceof PDFRef ? this.copyPDFIndirectObject(object)
              : object instanceof PDFInvalidObject ? this.copyPDFInvalidObject(object)
                : object.clone()
  ) as T;

  private copyPDFPage = (originalPage: PDFPageLeaf): PDFPageLeaf => {
    const clonedPage = originalPage.clone();

    // Move any entries that the originalPage is inheriting from its parent
    // tree nodes directly into originalPage so they are preserved during
    // the copy.
    const { InheritableEntries } = PDFPageLeaf;
    for (let idx = 0, len = InheritableEntries.length; idx < len; idx++) {
      const key = PDFName.of(InheritableEntries[idx]);
      const value = clonedPage.getInheritableAttribute(key)!;
      if (!clonedPage.get(key) && value) clonedPage.set(key, value);
    }

    // Remove the parent reference to prevent the whole donor document's page
    // tree from being copied when we only need a single page.
    clonedPage.delete(PDFName.of('Parent'));

    return this.copyPDFDict(clonedPage) as PDFPageLeaf;
  };

  private copyPDFDict = (originalDict: PDFDict): PDFDict => {
    if (this.traversedObjects.has(originalDict)) {
      return this.traversedObjects.get(originalDict) as PDFDict;
    }

    const clonedDict = originalDict.clone(this.dest);
    this.traversedObjects.set(originalDict, clonedDict);

    const entries = originalDict.entries();

    for (let idx = 0, len = entries.length; idx < len; idx++) {
      const [key, value] = entries[idx];

      // Special handling for CIDSystemInfo in CIDFont objects
      if (
        this.isCIDFontDict(originalDict) &&
        key.toString() === '/CIDSystemInfo'
      ) {
        const fixedCIDSystemInfo = this.getFixedCIDSystemInfo(value);
        clonedDict.set(key, fixedCIDSystemInfo);
      } else {
        clonedDict.set(key, this.copy(value));
      }
    }

    return clonedDict;
  };

  private copyPDFArray = (originalArray: PDFArray): PDFArray => {
    if (this.traversedObjects.has(originalArray)) {
      return this.traversedObjects.get(originalArray) as PDFArray;
    }

    const clonedArray = originalArray.clone(this.dest);
    this.traversedObjects.set(originalArray, clonedArray);

    for (let idx = 0, len = originalArray.size(); idx < len; idx++) {
      const value = originalArray.get(idx);
      clonedArray.set(idx, this.copy(value));
    }

    return clonedArray;
  };

  private copyPDFStream = (originalStream: PDFStream): PDFStream => {
    if (this.traversedObjects.has(originalStream)) {
      return this.traversedObjects.get(originalStream) as PDFStream;
    }

    const clonedStream = originalStream.clone(this.dest);
    this.traversedObjects.set(originalStream, clonedStream);

    const entries = originalStream.dict.entries();
    for (let idx = 0, len = entries.length; idx < len; idx++) {
      const [key, value] = entries[idx];
      clonedStream.dict.set(key, this.copy(value));
    }

    return clonedStream;
  };

  private copyPDFIndirectObject = (ref: PDFRef): PDFRef => {
    const alreadyMapped = this.traversedObjects.has(ref);

    if (!alreadyMapped) {
      const newRef = this.dest.nextRef();
      this.traversedObjects.set(ref, newRef);

      const dereferencedValue = this.src.lookup(ref);
      if (dereferencedValue) {
        const cloned = this.copy(dereferencedValue);
        this.dest.assign(newRef, cloned);

        // Debug logging for font-related objects
        /*
        if (process.env.DEBUG_FONT_COPY === '1') {
          if (dereferencedValue instanceof PDFDict) {
            const type = dereferencedValue.get(PDFName.of('Type'));
            const subtype = dereferencedValue.get(PDFName.of('Subtype'));
            if (
              type &&
              (type.toString() === '/Font' ||
                (subtype && subtype.toString().includes('Font')))
            ) {
              console.log(
                `Font object copied: ${ref.toString()} -> ${newRef.toString()}`,
              );
              console.log(
                `  Original type: ${dereferencedValue.constructor.name}`,
              );
              console.log(`  Cloned type: ${cloned.constructor.name}`);
            }
          }
        }
        */
      } else {
        // If the referenced object doesn't exist in source,
        // assign null to prevent broken references in destination
        this.dest.assign(newRef, this.dest.obj(null));

        /*
        if (process.env.DEBUG_FONT_COPY === '1') {
          console.log(`Missing object: ${ref.toString()} -> assigned null`);
        }
        */
      }
    }

    return this.traversedObjects.get(ref) as PDFRef;
  };

  private isCIDFontDict = (dict: PDFDict): boolean => {
    const type = dict.get(PDFName.of('Type'));
    const subtype = dict.get(PDFName.of('Subtype'));

    return !!(
      type &&
      type.toString() === '/Font' &&
      subtype &&
      (subtype.toString() === '/CIDFontType0' ||
        subtype.toString() === '/CIDFontType2')
    );
  };

  private getFixedCIDSystemInfo = (
    originalCIDSystemInfo: PDFObject,
  ): PDFObject => {
    // If it's not a PDFDict, create a new clean one
    if (!(originalCIDSystemInfo instanceof PDFDict)) {
      /*
      if (process.env.DEBUG_FONT_COPY === '1') {
        console.log('CIDSystemInfo is not a PDFDict, creating new one');
      }
      */
      return this.dest.obj({
        Registry: PDFString.of('Adobe'),
        Ordering: PDFString.of('Identity'),
        Supplement: 0,
      });
    }

    // Check if the existing CIDSystemInfo has corrupted strings
    const registry = originalCIDSystemInfo.get(PDFName.of('Registry'));
    const ordering = originalCIDSystemInfo.get(PDFName.of('Ordering'));

    if (registry && ordering) {
      const registryStr = registry.toString();
      const orderingStr = ordering.toString();

      // If strings are corrupted/encrypted, create a new clean CIDSystemInfo
      if (
        this.hasNonAsciiChars(registryStr) ||
        this.hasNonAsciiChars(orderingStr)
      ) {
        /*
        if (process.env.DEBUG_FONT_COPY === '1') {
          console.log('Fixing corrupted CIDSystemInfo strings');
        }
        */
        return this.dest.obj({
          Registry: PDFString.of('Adobe'),
          Ordering: PDFString.of('Identity'),
          Supplement: 0,
        });
      }
    }

    // If CIDSystemInfo is clean, copy it normally
    return this.copy(originalCIDSystemInfo);
  };

  private hasNonAsciiChars = (str: string): boolean => {
    // Check if string contains non-ASCII characters (which would indicate encryption/corruption)
    // Skip parentheses at the beginning and end which are PDF string delimiters
    let cleanStr = str;
    if (str.startsWith('(') && str.endsWith(')')) {
      cleanStr = str.slice(1, -1);
    }

    for (let i = 0; i < cleanStr.length; i++) {
      const code = cleanStr.charCodeAt(i);
      if (code > 127 || code < 32) {
        return true;
      }
    }
    return false;
  };

  private copyPDFInvalidObject = (
    invalidObject: PDFInvalidObject,
  ): PDFInvalidObject => {
    // For PDFInvalidObject, we should try to copy it as-is
    // This preserves the original data even if it couldn't be parsed properly
    return invalidObject.clone();
  };
}

export default PDFObjectCopier;
