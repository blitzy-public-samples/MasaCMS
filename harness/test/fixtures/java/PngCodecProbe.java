import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.security.MessageDigest;
import java.util.Iterator;
import java.util.StringJoiner;
import javax.imageio.ImageIO;

/**
 * Prints ImageIO's PNG reader and writer order, then the SHA-256 of a PNG and of its top-left quarter re-encoded the
 * way ColdFusion's imageRead and ImageWrite do (ImageIO.read, ImageIO.write). Arguments: PNG path, identity hashes to
 * draw before ImageIO loads.
 */
public final class PngCodecProbe {
  private PngCodecProbe() {}

  public static void main(String[] args) throws Exception {
    // Identity hashes order unordered ImageIO plugins; drawing some first stands in for a busier server start.
    for (int i = Integer.parseInt(args[1]); i > 0; i--) new Object().hashCode();
    System.out.println("readers=" + names(ImageIO.getImageReadersByFormatName("png")));
    System.out.println("writers=" + names(ImageIO.getImageWritersByFormatName("png")));
    BufferedImage image = ImageIO.read(new File(args[0]));
    System.out.println("full=" + encoded(image));
    System.out.println("crop=" + encoded(image.getSubimage(0, 0, image.getWidth() / 2, image.getHeight() / 2)));
  }

  private static String names(Iterator<?> plugins) {
    StringJoiner joined = new StringJoiner(",");
    while (plugins.hasNext()) joined.add(plugins.next().getClass().getName());
    return joined.toString();
  }

  private static String encoded(BufferedImage image) throws Exception {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    if (!ImageIO.write(image, "png", out)) throw new IllegalStateException("no PNG writer");
    StringBuilder hex = new StringBuilder();
    for (byte b : MessageDigest.getInstance("SHA-256").digest(out.toByteArray())) hex.append(String.format("%02x", b));
    return hex.toString();
  }
}
