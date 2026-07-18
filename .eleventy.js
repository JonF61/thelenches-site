module.exports = function (eleventyConfig) {
  eleventyConfig.addPassthroughCopy("src/style.css");

  return {
    pathPrefix: "/thelenches-site/",
    dir: {
      input: "src",
      includes: "_includes",
      data: "_data",
      output: "_site",
    },
    htmlTemplateEngine: "njk",
    markdownTemplateEngine: "njk",
  };
};
